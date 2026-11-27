export declare const SOLIDCRAFT_DEFAULT_CLI = "/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli";
export declare const SOLIDCRAFT_TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            design_path?: undefined;
            parameters?: undefined;
            format?: undefined;
            quality?: undefined;
            objects?: undefined;
            preserve_plate?: undefined;
            preview?: undefined;
            output_dir?: undefined;
            timeout_ms?: undefined;
            executable?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            design_path: {
                type: string;
                description: string;
            };
            parameters: {
                type: string;
                additionalProperties: {
                    type: string;
                };
                description: string;
            };
            format: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            quality: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            objects: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            preserve_plate: {
                type: string;
                default: boolean;
                description: string;
            };
            preview: {
                type: string;
                default: boolean;
                description: string;
            };
            output_dir: {
                type: string;
                description: string;
            };
            timeout_ms: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            executable: {
                type: string;
                description: string;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
})[];
export declare class SolidcraftEngine {
    private readonly outputRoots;
    constructor(outputRoots: string[]);
    private executable;
    private invoke;
    status(args?: Record<string, unknown>, signal?: AbortSignal): Promise<{
        installed: boolean;
        executable: string;
        version: string;
        error?: undefined;
    } | {
        installed: boolean;
        executable: string;
        error: string;
        version?: undefined;
    }>;
    export(args: Record<string, unknown>, signal?: AbortSignal): Promise<{
        next: {
            tool: string;
            arguments: {
                stl_path: string;
                arrange: boolean;
            };
            objects: {} | undefined;
            guidance: string;
        };
        preview_path?: string | undefined;
        path: string;
        design_path: string;
        evaluated_design_path: string;
        bodies: any;
        bbox: {
            min: number[];
            max: number[];
        };
        volume_mm3: any;
    }>;
}
