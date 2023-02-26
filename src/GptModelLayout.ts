import { IGptGpuModel, IModelShape } from "./GptModel";
import { isNil } from "./utils/data";
import { Mat3f } from "./utils/matrix";
import { IBufferTex } from "./utils/renderPhases";

interface IBlkDef {
    t: 'w' | 'i', // weights; intermediate value
    x: number;
    y: number;
    z: number;
    cx: number; // units: number of cells
    cy: number;
    cz: number;
    access?: IBlkAccess;
}

interface IBlkAccess {
    src: IBufferTex;
    channel: 'r' | 'g' | 'b';
    scale: number;
    mat: Mat3f; // actually using the first two columns for a 3x2 matrix: mapping (x, y, z) integer cell coord to (x, y) src tex coord
}

interface IBlkAccessDefArgs {
    src?: IBufferTex;
    channel?: 'r' | 'g' | 'b';
    scale?: number;
    x: number[];
    y: number[];
}

interface IBlkDefArgs {
    t: 'w' | 'i', // weights; intermediate value
    xL?: number; // pos of Left edge
    xR?: number; // Right
    xM?: number; // Middle
    yF?: number; // Front
    yB?: number; // Back
    yM?: number; // Middle
    z: number;
    cx: number; // units: number of cells
    cy: number;
    cz: number;
    access?: IBlkAccessDefArgs;
}


export function genGptModelLayout(shape: IModelShape, gptGpuModel: IGptGpuModel | null = null) {
    let { B, T, C, vocabSize, nHeads, A, nBlocks } = shape;

    // work our way downwards from the top
    // x is to the left and right
    // y is coming out of the page
    // z is going down the stack

    // a single batch of the residual pathway goes down the x-z plane
    // weights & off-residual pathways are left & right of the residual pathway (i.e. along x)
    // those blocks might have y-depth but that's OK: still have space to add batches
    // x = 0 is just to the left of time-cell t=0

    let z = 0;

    let cell = 1.5;
    let margin = 4;

    function mk(args: IBlkDefArgs): IBlkDef {
        let xDef = [args.xL, args.xR, args.xM].map(a => +!isNil(a)).reduce((a, b) => a + b, 0);
        let yDef = [args.yF, args.yB, args.yM].map(a => +!isNil(a)).reduce((a, b) => a + b, 0);
        if (xDef !== 1 || yDef !== 1) {
            throw new Error(`Must supply exactly 1 x arg & 1 y arg: ${JSON.stringify(args)}`);
        }
        let dx = args.cx * cell;
        let dy = args.cy * cell;
        let x = !isNil(args.xL) ? args.xL : !isNil(args.xR) ? args.xR - dx : args.xM! - dx / 2;
        let y = !isNil(args.yB) ? args.yB : !isNil(args.yF) ? args.yF - dy : args.yM! - dy / 2;

        return {
            t: args.t,
            x: x,
            y: y,
            z: args.z,
            cx: args.cx,
            cy: args.cy,
            cz: args.cz,
            access: args.access?.src ? {
                channel: args.access.channel ?? 'r',
                src: args.access.src,
                scale: args.access.scale ?? 10.0,
                mat: Mat3f.fromColMajor([...args.access.x, ...args.access.y, 0, 0, 0]),
            } : undefined,
        };
    }

    let cubes: IBlkDef[] = [];

    let idxObj = mk({
        t: 'i', cx: T, cy: B, cz: 1, z: z,
        xM: 0, yM: 0,
        access: { src: gptGpuModel?.inputTokens, x: [0, 0, 1], y: [1, T, 0], scale: 1 / vocabSize}
    });

    let leftX = -T * cell / 2 - margin;
    let rightX = T * cell / 2 + margin;

    z += cell + margin;

    let tokEmbedObj = mk({
        t: 'w',
        xR: leftX, yM: 0, z: z,
        cx: vocabSize, cy: 1, cz: C, // src has shape [vocabSize, C]
        access: { src: gptGpuModel?.vocabEmbed.weight, x: [0, 0, 1], y: [1, 0, 0] },
    });

    let posEmbedObj = mk({
        t: 'w',
        xL: rightX, yM: 0, z: z,
        cx: T, cy: 1, cz: C,
        access: { src: gptGpuModel?.posEmbed.weight, x: [0, 0, 1], y: [1, 0, 0] },
    });

    let residual0 = mk({
        t: 'i',
        xM: 0, yM: 0, z: z,
        cx: T, cy: B, cz: C,
        access: { src: gptGpuModel?.add.output, x: [0, 0, 1], y: [1, T, 0] },
    });
    cubes.push(idxObj, tokEmbedObj, posEmbedObj, residual0);

    z += C * cell + margin;

    function createLn(x: number) {
        let lnLeftX = leftX + x;
        let resLeftX = lnLeftX - T * cell - margin;

        let lnAgg = mk({
            t: 'i', cx: T, cy: B, cz: 2, z: z,
            xR: lnLeftX, yM: 0,
        });
        z += 2 * cell + margin;
        let lnResid = mk({
            t: 'i', cx: T, cy: B, cz: C, z: z,
            xR: lnLeftX, yM: 0,
        });
        let lnSigma = mk({
            t: 'w', cx: 1, cy: 1, cz: C, z: z,
            xR: resLeftX, yM: 0,
        });
        let lnMu = mk({
            t: 'w', cx: 1, cy: 1, cz: C, z: z,
            xR: resLeftX - cell * 1 - margin, yM: 0
        });
        cubes.push(lnAgg, lnResid, lnSigma, lnMu);
        return { lnAgg, lnResid, lnSigma, lnMu };
    }

    let lnLeftX = leftX - (T + 2) * cell - 3 * margin;
    // @TODO: loop through the blocks

    function createBlock() {
        let ln1 = createLn(0);

        let interHeadMargin = 3 * margin;
        let qkvMargin = 1 * margin;

        let headWidth = 3 * B * cell + qkvMargin * 2 + interHeadMargin;

        let attn1Z = z + A * cell + margin;
        let attn2Z = attn1Z; // + T * cell + margin;
        let vOutZ = attn2Z + T * cell + margin;

        let attnLeftX = lnLeftX; // leftX - ((T + 2) * cell + 3 * margin);
        let qkvValLeftX = attnLeftX - T * cell - margin;
        let stepPerHeadZ = 0; // A * cell;

        let heads = [];
        for (let i = 0; i < nHeads; i++) {
            let headYMid = headWidth * i - (nHeads - 1) * headWidth / 2;
            let qMid = headYMid - B * cell - qkvMargin;
            let kMid = headYMid;
            let vMid = headYMid + B * cell + qkvMargin;
            let attnMid = (qMid + kMid) / 2;
            let attn2Mid = (kMid + vMid) / 2;

            let qBlock = mk({
                t: 'i', cx: T, cy: B, cz: A, z: z,
                xR: attnLeftX, yM: qMid,
            });

            let kBlock = mk({
                t: 'i', cx: T, cy: B, cz: A, z: z,
                xR: attnLeftX, yM: kMid,
            });

            let vBlock = mk({
                t: 'i', cx: T, cy: B, cz: A, z: z,
                xR: attnLeftX, yM: vMid,
            });

            let qWeightBlock = mk({
                t: 'w', cx: C, cy: 1, cz: A, z: z,
                xR: qkvValLeftX, yM: qMid,
            });

            let kWeightBlock = mk({
                t: 'w', cx: C, cy: 1, cz: A, z: z,
                xR: qkvValLeftX, yM: kMid,
            });

            let vWeightBlock = mk({
                t: 'w', cx: C, cy: 1, cz: A, z: z,
                xR: qkvValLeftX, yM: vMid,
            });

            let attnMtx = mk({
                t: 'i', cx: T, cy: B, cz: T, z: attn1Z,
                xR: attnLeftX, yM: attnMid,
            });

            let attnMtxAgg = mk({
                t: 'i', cx: 2, cy: B, cz: T, z: attn1Z,
                xR: attnLeftX - T * cell - margin, yM: attnMid,
            });

            let attnMtxSm = mk({
                t: 'i', cx: T, cy: B, cz: T, z: attn2Z,
                xR: attnLeftX, yM: attn2Mid,
            });

            let vOutBlock = mk({
                t: 'i', cx: T, cy: B, cz: A, z: vOutZ + i * stepPerHeadZ,
                xR: attnLeftX, yM: vMid,
            });

            let head = {
                qBlock, kBlock, vBlock, qWeightBlock, kWeightBlock, vWeightBlock, attnMtx,
            };
            heads.push(head);
            cubes.push(qBlock, kBlock, vBlock, qWeightBlock, kWeightBlock, vWeightBlock,
                attnMtx, attnMtxAgg, attnMtxSm, vOutBlock);

        }

        // let vOutCombined = mk({
        //     t: 'i', cx: T, cy: B, cz: C, z: vOutZ,
        //     xR: attnLeftX, yF: - headWidth * nHeads / 2,
        // });

        let vFinalZ = Math.max(
            vOutZ + stepPerHeadZ * (nHeads - 1) + A * cell + margin,
            z + C * cell + margin, // in case the layer norm block is shorter
        );

        let projWeight = mk({
            t: 'w', cx: C, cy: 1, cz: C, z: vFinalZ,
            xR: qkvValLeftX, yM: 0,
        });

        let attnOut = mk({
            t: 'i', cx: T, cy: B, cz: C, z: vFinalZ,
            xR: attnLeftX, yM: 0,
        });

        let attnResidual = mk({
            t: 'i', cx: T, cy: B, cz: C, z: vFinalZ,
            xM: 0, yM: 0,
        });


        cubes.push(projWeight, attnOut, attnResidual);

        z = vFinalZ + C * cell + margin;

        let ln2 = createLn(0);

        let mplFCWeight = mk({
            t: 'w', cx: C * 4, cy: 1, cz: C, z: z,
            xR: attnLeftX, yM: 0,
        });

        z += C * cell + margin;

        let mlpFc = mk({
            t: 'i', cx: C * 4, cy: B, cz: T, z: z,
            xR: attnLeftX, yM: 0,
        });

        z += T * cell + margin;

        let mlpAct = mk({
            t: 'i', cx: C * 4, cy: B, cz: T, z: z,
            xR: attnLeftX, yM: 0,
        });

        z += T * cell + margin;

        let mlpProjWeight = mk({
            t: 'w', cx: C * 4, cy: 1, cz: C, z: z,
            xR: attnLeftX, yM: 0,
        });

        let mlpResult = mk({
            t: 'i', cx: T, cy: B, cz: C, z: z,
            xL: attnLeftX + margin, yM: 0,
        });

        let mlpResidual = mk({
            t: 'i', cx: T, cy: B, cz: C, z: z,
            xM: 0, yM: 0,
        });

        z += C * cell + margin;

        cubes.push(mlpFc, mplFCWeight, mlpAct, mlpProjWeight, mlpResult, mlpResidual);

        return {
            ln1,
            heads,
            projWeight,
            attnOut,
            ln2,
        };
    }

    let blockHalfMargin = 4 * margin;

    z += blockHalfMargin;

    let blocks = [];
    for (let i = 0; i < nBlocks; i++) {
        z += blockHalfMargin;
        blocks.push(createBlock());
        z += blockHalfMargin;
    }

    z += blockHalfMargin;
    let ln_f = createLn(T * cell + margin);

    z += C * cell + margin;

    let lmHeadWeight = mk({
        t: 'w', cx: C, cy: 1, cz: vocabSize, z: z,
        xR: leftX, yM: 0,
    });

    let logits = mk({
        t: 'i', cx: T, cy: B, cz: vocabSize, z: z,
        xM: 0, yM: 0,
    });

    z += vocabSize * cell + margin;

    let logitsAgg = mk({
        t: 'i', cx: T, cy: B, cz: 2, z: z,
        xM: 0, yM: 0,
    });

    z += 2 * cell + margin;

    let logitsSoftmax = mk({
        t: 'i', cx: T, cy: B, cz: vocabSize, z: z,
        xM: 0, yM: 0,
    });

    cubes.push(lmHeadWeight, logits, logitsAgg, logitsSoftmax);

    return {
        cubes,
        cell,
        idxObj,
        tokEmbedObj,
        posEmbedObj,
        residual0,
        blocks,
        height: z,
    };
}

export type IModelLayout = ReturnType<typeof genGptModelLayout>;
