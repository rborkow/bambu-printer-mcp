import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { Builder, parseStringPromise } from "xml2js";
import { execFile } from "node:child_process";

export const SOLIDCRAFT_DEFAULT_CLI = "/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli";
export const SOLIDCRAFT_TOOLS = [
  { name: "solidcraft_status", description: "Check the configured local SolidCraft CLI installation and version; does not connect to or edit the desktop design.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "solidcraft_export", description: "Export a saved .sc design headlessly, leaving the desktop session untouched. Prefer 3MF; by default groups 3MF bodies as one object with parts so auto-arrange preserves their relative positions (objects: separate keeps each body its own object). Returns measured bodies, bounds, volume and optional preview. Never prints or overwrites. Configure SOLIDCRAFT_CLI in the server environment.",
    inputSchema: { type: "object", properties: {
      design_path: { type: "string", description: "Existing saved .sc file." },
      parameters: { type: "object", additionalProperties: { type: "string" }, description: "Existing parameter names to length expressions; no shell interpretation." },
      format: { type: "string", enum: ["3mf", "stl"], default: "3mf", description: "Export format; 3MF retains named parts." },
      quality: { type: "string", enum: ["standard", "fine", "finest"], default: "standard", description: "Tessellation quality." },
      objects: { type: "string", enum: ["assembly", "separate"], default: "assembly", description: "3MF only. assembly: every body becomes a part of one object, so bodies that touch (a boss on a base) stay where they were designed. separate: each body is its own object that the slicer drops onto the bed and arranges on its own; use it for parts modelled in assembled position (a lid above its box) that print side by side." },
      preserve_plate: { type: "boolean", default: false, description: "Return arrange:false to retain absolute plate coordinates. Default arranges the grouped assembly as a whole." },
      preview: { type: "boolean", default: false, description: "Render an isometric PNG from the evaluated design." },
      output_dir: { type: "string", description: "Existing TEMP_DIR or trusted CAD_OUTPUT_DIRS directory; defaults to server temporary directory." },
      timeout_ms: { type: "integer", minimum: 100, maximum: 300000, default: 120000, description: "Total CLI deadline in milliseconds; timeout kills the child and fails even if files exist." },
      executable: { type: "string", description: "Only allowed with trusted MCP_ALLOW_EXECUTABLE_ARG=1; normally use SOLIDCRAFT_CLI." },
    }, required: ["design_path"], additionalProperties: false } },
];

export class SolidcraftEngine {
  constructor(private readonly outputRoots: string[]) {}
  private executable(args: Record<string, unknown>) {
    if (args.executable !== undefined && process.env.MCP_ALLOW_EXECUTABLE_ARG !== "1")
      throw new Error("Per-call executable overrides require MCP_ALLOW_EXECUTABLE_ARG=1; configure SOLIDCRAFT_CLI instead.");
    const executable = args.executable ?? process.env.SOLIDCRAFT_CLI ?? SOLIDCRAFT_DEFAULT_CLI;
    if (typeof executable !== "string" || !executable) throw new Error("Invalid SolidCraft executable.");
    return executable;
  }
  private async invoke(executable: string, argv: string[], timeout: number, signal?: AbortSignal): Promise<string> {
    try {
      return await new Promise<string>((resolve, reject) => {
        if (signal?.aborted) { reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); return; }
        // execFile's AbortSignal path can settle before the child has exited.
        // Kill explicitly and let the completion callback reap it before returning.
        const abort = () => { child.kill("SIGKILL"); };
        const child = execFile(executable, argv, { timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => {
            signal?.removeEventListener("abort", abort);
            if (error) reject(Object.assign(error, { detail: stderr }));
            else if (signal?.aborted) reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
            else resolve(stdout);
          });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { killed?: boolean; detail?: string };
      if (e.code === "ENOENT") throw new Error("SolidCraft is not installed at " + executable + ". Install SolidCraft or configure SOLIDCRAFT_CLI.");
      if (e.killed || e.name === "AbortError") throw new Error("SolidCraft timed out or was cancelled; child killed. Any partial outputs are unverified and are not returned. No automatic retry.");
      throw new Error("SolidCraft failed: " + (e.detail || e.message));
    }
  }
  async status(args: Record<string, unknown> = {}, signal?: AbortSignal) {
    if (Object.keys(args).length) throw new Error("solidcraft_status takes no arguments.");
    const executable = this.executable({});
    try { return { installed: true, executable, version: (await this.invoke(executable, ["--version"], 5000, signal)).trim() }; }
    catch (e) { return { installed: false, executable, error: (e as Error).message }; }
  }
  async export(args: Record<string, unknown>, signal?: AbortSignal) {
    const allowed = new Set(["design_path", "parameters", "format", "objects", "quality", "preserve_plate", "preview", "output_dir", "timeout_ms", "executable"]);
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error("Unknown solidcraft_export argument: " + key);
    const executable = this.executable(args);
    if (typeof args.design_path !== "string" || path.extname(args.design_path).toLowerCase() !== ".sc")
      throw new Error("design_path must be an existing regular .sc file.");
    const design = await fs.realpath(args.design_path).catch(() => { throw new Error("design_path must be an existing regular .sc file."); });
    if (!(await fs.stat(design)).isFile()) throw new Error("design_path must be an existing regular .sc file.");
    const format = args.format ?? "3mf", quality = args.quality ?? "standard";
    if (!["3mf", "stl"].includes(String(format))) throw new Error("format must be 3mf or stl.");
    if (!["standard", "fine", "finest"].includes(String(quality))) throw new Error("Invalid quality.");
    for (const key of ["preview", "preserve_plate"]) if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(key + " must be boolean.");
    const objects = args.objects ?? "assembly";
    if (!["assembly", "separate"].includes(String(objects))) throw new Error("objects must be assembly or separate.");
    if (format === "stl" && args.objects !== undefined) throw new Error("objects applies to 3MF only.");
    if (objects === "separate" && args.preserve_plate === true) throw new Error("objects: separate lets the slicer place each body; it cannot be combined with preserve_plate.");
    if (format === "stl" && args.preserve_plate === true) throw new Error("preserve_plate requires 3MF; STL has no plate layout.");
    const timeout = args.timeout_ms ?? 120000;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > 300000) throw new Error("timeout_ms must be an integer from 100 to 300000.");
    const parameters = args.parameters ?? {};
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("parameters must be a name/expression object.");
    const paramArgs: string[] = [];
    for (const [name, expr] of Object.entries(parameters)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof expr !== "string" || !expr.trim() || expr.includes("\0"))
        throw new Error("Invalid parameter name or expression.");
      paramArgs.push("--param", name + "=" + expr);
    }
    if (args.output_dir !== undefined && typeof args.output_dir !== "string") throw new Error("Invalid output_dir.");
    const dir = await fs.realpath(path.resolve(args.output_dir as string ?? this.outputRoots[0]));
    const roots = await Promise.all(this.outputRoots.map(root => fs.realpath(root).catch(() => "")));
    if (!(await fs.stat(dir)).isDirectory() || !roots.some(root => root && (dir === root || dir.startsWith(root + path.sep))))
      throw new Error("output_dir is outside allowed output directories (TEMP_DIR or trusted CAD_OUTPUT_DIRS).");
    const job = await fs.mkdtemp(path.join(dir, "solidcraft-"));
    const output = path.join(job, "part." + format), saved = path.join(job, "evaluated.sc"), report = path.join(job, "eval.json");
    const deadline = Date.now() + timeout;
    const run = (argv: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SolidCraft deadline expired; partial outputs are unverified.");
      return this.invoke(executable, argv, remaining, signal);
    };
    // Snapshot the handoff so a save in the desktop cannot change it between export and measurement.
    const input = path.join(job, "input.sc");
    await fs.copyFile(design, input);
    await run(["run", "--in", input, ...paramArgs, "--out", output, "--save", saved, "--quality", String(quality), "--quiet"]);
    if (!(await fs.stat(output)).isFile() || !(await fs.stat(output)).size) throw new Error("SolidCraft did not write a nonempty export.");
    if (format === "3mf" && objects === "assembly") {
      // Group every placed build item, including root-level bodies. Component-mode
      // export alone only groups bodies already in the same placed CAD component.
      const zip = await JSZip.loadAsync(await fs.readFile(output));
      const modelFile = zip.file("3D/3dmodel.model");
      if (!modelFile) throw new Error("SolidCraft export has no 3MF model.");
      const document = await parseStringPromise(await modelFile.async("string"));
      const model = document.model, resources = model?.resources?.[0], build = model?.build?.[0];
      if (!resources || !Array.isArray(build?.item) || !build.item.length)
        throw new Error("SolidCraft export has no build items.");
      const ids = Object.values(resources).flat().map((entry: any) => Number(entry?.$?.id)).filter(Number.isFinite);
      const id = String(Math.max(0, ...ids) + 1);
      const components = build.item.map((item: any) => {
        if (!item.$?.objectid) throw new Error("Invalid SolidCraft 3MF build item.");
        const attrs: Record<string, string> = { objectid: item.$.objectid };
        for (const key of ["transform", "p:path"]) if (item.$[key] !== undefined) attrs[key] = item.$[key];
        return { $: attrs };
      });
      resources.object ??= [];
      resources.object.push({ $: { id, type: "model", name: "SolidCraft assembly" }, components: [{ component: components }] });
      build.item = [{ $: { objectid: id } }];
      zip.file("3D/3dmodel.model", new Builder().buildObject(document));
      await fs.writeFile(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    }
    await run(["eval", "--in", saved, "--json-out", report, "--quiet"]);
    const measurement = JSON.parse(await fs.readFile(report, "utf8"));
    if (!Array.isArray(measurement.bodies) || !measurement.bodies.length || !Number.isFinite(measurement.total?.volume_mm3))
      throw new Error("SolidCraft returned incomplete measurements.");
    const bodies = measurement.bodies;
    for (const body of bodies) {
      if (!Number.isFinite(body.volume_mm3) || !["min", "max"].every(key => Array.isArray(body.bbox?.[key]) && body.bbox[key].length === 3 && body.bbox[key].every(Number.isFinite)))
        throw new Error("SolidCraft returned invalid body measurements.");
    }
    const bbox = { min: [0,1,2].map(i => Math.min(...bodies.map((b: any) => b.bbox.min[i]))),
      max: [0,1,2].map(i => Math.max(...bodies.map((b: any) => b.bbox.max[i]))) };
    let preview_path: string | undefined;
    if (args.preview) {
      preview_path = path.join(job, "preview.png");
      await run(["snapshot", "--in", saved, "--out", preview_path, "--view", "iso"]);
      if (!(await fs.stat(preview_path)).size) throw new Error("SolidCraft preview is empty.");
    }
    return { path: output, design_path: design, evaluated_design_path: saved, bodies, bbox, volume_mm3: measurement.total.volume_mm3,
      ...(preview_path ? { preview_path } : {}), next: { tool: "slice_stl", arguments: { stl_path: output, arrange: args.preserve_plate !== true },
        objects: format === "3mf" ? objects : undefined,
        guidance: "Supply bambu_model and the desired process/material settings. " + (objects === "separate" ? "Each body is its own object; the slicer drops each onto the bed and arranges it." : "3MF parts are grouped and arrange as one assembly.") + " Use preserve_plate:true only for a design already positioned on the plate; slice and inspect before printing. Export alone does not verify printability." } };
  }
}
