// Mesh-mode cad_run results that fail their checks say why, piece by piece. Before, valid: false arrived with an
// empty problems list, and the zero-volume sheets a boolean union leaves at its seams had to be found by hand
// (the low-poly Dimetrodon of 2026-11-24). Needs a Python with the pinned CAD runtime:
// CAD_PYTHON, or CAD_E2E_DATA_DIR/runtime/bin/python after cad_setup.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../src/cad/worker.py", import.meta.url));
const python =
  process.env.CAD_PYTHON ??
  (process.env.CAD_E2E_DATA_DIR
    ? path.join(process.env.CAD_E2E_DATA_DIR, "runtime", "bin", "python")
    : undefined);
const runtime = {
  skip:
    !python ||
    spawnSync(python, ["-I", "-c", "import build123d"], { timeout: 60000 })
      .status !== 0
      ? "set CAD_PYTHON (or CAD_E2E_DATA_DIR) to a Python with the pinned CAD runtime"
      : false,
  timeout: 300000,
};

function inspectMesh(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-mesh-problems-"));
  try {
    fs.writeFileSync(path.join(dir, "part.py"), source);
    fs.writeFileSync(path.join(dir, "p.json"), "{}");
    const request = path.join(dir, "request.json");
    fs.writeFileSync(
      request,
      JSON.stringify({
        output: dir,
        name: "part",
        script: path.join(dir, "part.py"),
        parameters: path.join(dir, "p.json"),
        mode: "mesh",
      }),
    );
    for (const mode of ["build", "inspect"]) {
      const r = spawnSync(python, ["-I", "-B", worker, mode, request], {
        encoding: "utf8",
        timeout: 240000,
      });
      assert.equal(r.status, 0, r.stderr);
      if (mode === "inspect") return JSON.parse(r.stdout);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PRELUDE = `import numpy as np
import trimesh
P = {'size': 10.0}
`;

test("a valid mesh has no mesh problems", runtime, () => {
  const r = inspectMesh(
    PRELUDE + "def build():\n    return trimesh.creation.box([P['size']] * 3)\n",
  );
  assert.equal(r.valid, true);
  assert.deepEqual(r.problems, []);
});

test("zero-volume sheets and inside-out pieces are named with where they are and how to fix them", runtime, () => {
  // A good box, a closed but flat double-sided quad (what a union leaves at a shared face), and an inside-out box.
  const r = inspectMesh(
    PRELUDE +
      `def build():
    box = trimesh.creation.box([P['size']] * 3)
    v = np.array([[20, 0, 0], [24, 0, 0], [24, 0, 4], [20, 0, 4]], float)
    sheet = trimesh.Trimesh(v, [[0, 1, 2], [0, 2, 3], [0, 2, 1], [0, 3, 2]], process=False)
    inside_out = trimesh.creation.box([4, 4, 4])
    inside_out.apply_translation([40, 0, 2])
    inside_out.invert()
    return trimesh.util.concatenate([box, sheet, inside_out])
`,
  );
  assert.equal(r.valid, false);
  const text = r.problems.join("\n");
  assert.match(text, /\d+ of \d+ mesh pieces enclose no volume/);
  assert.match(text, /x 20\.0\.\.24\.0/);
  assert.match(text, /keep the\s+largest piece/);
  assert.match(text, /1 mesh piece\(s\) are inside out/);
  assert.match(text, /x 38\.0\.\.42\.0/);
});
