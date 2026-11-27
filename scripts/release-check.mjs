/**
 * Release-readiness checks that can run locally and in CI.
 *
 * These checks do not publish anything. They verify that the package metadata,
 * licence, documentation, binaries, and demo assets agree before a tag or a
 * Devpost submission is considered.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) {
    process.stderr.write("FAIL " + message + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("ok " + String(checks) + " - " + message + "\n");
  }
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versionSource = readFileSync("src/version.ts", "utf8");
const marker = "export const TOOL_VERSION = '";
const versionStart = versionSource.indexOf(marker);
const versionEnd = versionStart < 0 ? -1 : versionSource.indexOf("'", versionStart + marker.length);
const version = versionStart < 0 || versionEnd < 0 ? null : versionSource.slice(versionStart + marker.length, versionEnd);

check(version !== null, "src/version.ts declares TOOL_VERSION");
check(version !== null && version === pkg.version, "package.json and src/version.ts versions agree");
check(pkg.private === true, "package remains private (no accidental npm publish)");
check(pkg.license === "Apache-2.0", "package licence is Apache-2.0");
check(typeof pkg.repository?.url === "string" && pkg.repository.url.includes("github.com/fetachino/qnx-scheduloscope"), "repository URL points at the public repo");
check(typeof pkg.homepage === "string" && pkg.homepage.startsWith("https://"), "homepage is HTTPS");
check(pkg.engines?.node === ">=20.11", "Node engine floor is recorded");

const required = ["README.md", "LICENSE", "CHANGELOG.md", "dist/src/cli/main.js",
  "dist/src/codegen/templates/harness.c", "docs/verification.md", "docs/performance.md",
  "docs/release-checklist.md", "docs/qnx-kvm-boot.txt", "docs/qnx-kvm-report.json", "docs/qnx-stress.json",
  "docs/qnx-aarch64-boot.txt", "assets/scheduloscope-demo.mp4", "assets/scheduloscope-demo.vtt",
  ".github/workflows/ci.yml"];
for (const file of required) check(existsSync(file), "required file exists: " + file);

const bin = pkg.bin?.scheduloscope;
check(typeof bin === "string" && existsSync(bin), "CLI bin target exists: " + String(bin));
check(Array.isArray(pkg.files) && pkg.files.includes("dist") && pkg.files.includes("docs/performance.md"), "package files include dist and performance docs");

const licence = readFileSync("LICENSE", "utf8");
check(licence.includes("Apache License") && licence.includes("Version 2.0"), "LICENSE is the Apache 2.0 text");

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const secretLike = tracked.filter((file) => {
  const base = file.split("/").pop() ?? file;
  return base === ".env" || base.startsWith(".env.") || base === "id_rsa" || base.endsWith(".pem") || base.includes("credentials");
});
check(secretLike.length === 0, "no secret-like files are tracked: " + (secretLike.join(", ") || "none"));

const readme = readFileSync("README.md", "utf8");
check(readme.includes("docs/performance.md"), "README links the performance report");
check(readme.includes("docs/verification.md"), "README links the verification report");

for (const file of ["assets/scheduloscope-demo.mp4", "assets/scheduloscope-demo.vtt"]) {
  check(existsSync(file) && statSync(file).size > 0, "demo asset is non-empty: " + file);
}

if (process.exitCode) {
  process.stderr.write("release-check failed after " + String(checks) + " checks\n");
} else {
  process.stdout.write("release-check passed " + String(checks) + " checks\n");
}
