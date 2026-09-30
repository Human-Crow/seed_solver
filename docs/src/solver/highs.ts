// The parts of the highs-js API (HiGHS compiled to WebAssembly) that the solver uses.

export interface HighsCallbackData {
    mip_dual_bound?: number;
    mip_primal_bound?: number;
    mip_gap?: number;
    mip_solution?: Float64Array;
    objective_function_value?: number;
    running_time?: number;
}

export interface HighsCallbackEvent {
    data: HighsCallbackData;
    interrupt?: () => void;
}

export interface HighsModelData {
    numCols: number;
    numRows: number;
    sense: number;
    colCost: readonly number[] | Float64Array;
    colLower: readonly number[] | Float64Array;
    colUpper: readonly number[] | Float64Array;
    rowLower: readonly number[] | Float64Array;
    rowUpper: readonly number[] | Float64Array;
    matrix: {
        format: "csc";
        numRows: number;
        numCols: number;
        starts: readonly number[] | Int32Array;
        indices: readonly number[] | Int32Array;
        values: readonly number[] | Float64Array;
    };
    integrality?: readonly number[] | Int32Array;
}

export interface HighsModel {
    passModel(model: HighsModelData): unknown;
    options: { set(values: Record<string, unknown>): void };
    info: { get(name: string): number };
    run(callbacks?: Record<number, (event: HighsCallbackEvent) => void>): { modelStatus: number };
    getSolution(): { colValue: Float64Array; rowValue: Float64Array; rowDual: Float64Array; colDual: Float64Array };
    getObjectiveValue(): number;
    changeColsCost(selection: { kind: "range"; from: number; to: number }, costs: Float64Array | readonly number[]): unknown;
    changeColsBounds(
        selection: { kind: "range"; from: number; to: number },
        lower: Float64Array | readonly number[],
        upper: Float64Array | readonly number[]
    ): unknown;
    dispose(): void;
}

export interface HighsRuntime {
    constants: {
        objectiveSense: { minimize: number; maximize: number };
        variableType: { continuous: number; integer: number };
        modelStatus: Record<string, number>;
        callbackType: Record<string, number>;
    };
    createModel(): HighsModel;
}
