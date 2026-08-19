#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REGISTRY = "https://registry.npmjs.org/";
const BUMPS = new Set(["patch", "minor", "major"]);

function fail(message) {
  console.error(`\nRelease stopped: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0 && !options.allowFailure) {
    fail(options.errorMessage ?? `${command} exited with status ${result.status}`);
  }

  return result;
}

function output(command, args, options = {}) {
  const result = run(command, args, {
    ...options,
    capture: true,
  });
  return (result.stdout ?? "").trim();
}

function gitOutput(args, options = {}) {
  return output("git", args, options);
}

function readPackage() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}

function parseArguments(argv) {
  let bump;
  let dryRun = false;
  let otp;

  for (const argument of argv) {
    if (BUMPS.has(argument)) {
      if (bump) fail("choose only one version bump: patch, minor, or major");
      bump = argument;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument.startsWith("--otp=")) {
      otp = argument.slice("--otp=".length);
      if (!/^\d{6,10}$/.test(otp)) fail("--otp must contain 6 to 10 digits");
    } else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: pnpm release [patch|minor|major] [--dry-run] [--otp=CODE]

With no version argument, the first release keeps package.json's current version;
later releases default to a patch bump. A failed publish or push is resumed safely
when the command is run again.`);
      process.exit(0);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }

  return { bump, dryRun, otp };
}

function ensureStableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    fail(`package.json version ${JSON.stringify(version)} is not a stable x.y.z version`);
  }
  return match.slice(1).map(Number);
}

function incrementVersion(version, bump) {
  let [major, minor, patch] = ensureStableVersion(version);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function npmView(spec) {
  const result = run(
    "npm",
    ["view", spec, "version", "--json", `--registry=${REGISTRY}`],
    { capture: true, allowFailure: true },
  );

  if (result.status === 0) {
    const value = JSON.parse((result.stdout ?? "").trim());
    return Array.isArray(value) ? value.at(-1) : value;
  }

  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/\bE404\b|404 Not Found/.test(diagnostic)) return null;

  process.stderr.write(result.stderr ?? "");
  fail(`could not read ${spec} from ${REGISTRY}`);
}

function localTagCommit(tag) {
  return gitOutput(["rev-list", "-n", "1", tag], { allowFailure: true }) || null;
}

function remoteTagCommit(remote, tag) {
  const result = run(
    "git",
    ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) fail(`could not inspect ${tag} on ${remote}`);

  const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  return (peeled ?? lines[0])?.split(/\s+/)[0] ?? null;
}

function pushRelease(remote, branch, tag, dryRun = false) {
  const args = [
    "push",
    "--atomic",
    ...(dryRun ? ["--dry-run"] : []),
    remote,
    `HEAD:refs/heads/${branch}`,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ];
  run("git", args, {
    errorMessage: dryRun
      ? "Git rejected the release push during its dry run"
      : `npm is published, but Git could not push ${tag}. Run pnpm release again to resume`,
  });
}

function assertTagAtHead(tag, head) {
  const taggedCommit = localTagCommit(tag);
  if (taggedCommit !== head) {
    fail(
      taggedCommit
        ? `${tag} points to ${taggedCommit}, not the current commit ${head}`
        : `${tag} is required to resume this release but does not exist locally`,
    );
  }
}

const { bump: requestedBump, dryRun, otp } = parseArguments(process.argv.slice(2));
const packageJson = readPackage();
const { name, version: currentVersion } = packageJson;
ensureStableVersion(currentVersion);

if (!name || packageJson.private) {
  fail("package.json must have a publishable name and must not be private");
}

if (gitOutput(["status", "--porcelain"])) {
  fail("the Git working tree is not clean; commit or stash changes first");
}

const branch = gitOutput(["symbolic-ref", "--quiet", "--short", "HEAD"], {
  allowFailure: true,
});
if (!branch) fail("releases cannot run from a detached HEAD");

const upstream = gitOutput(
  ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  { allowFailure: true },
);
if (!upstream || !upstream.includes("/")) {
  fail(`branch ${branch} must have an upstream branch`);
}

const remote = upstream.slice(0, upstream.indexOf("/"));
run("git", ["fetch", "--prune", "--tags", remote]);

const head = gitOutput(["rev-parse", "HEAD"]);
const upstreamHead = gitOutput(["rev-parse", "@{upstream}"]);
const currentTag = `v${currentVersion}`;
const registryLatest = npmView(name);
const currentIsPublished = npmView(`${name}@${currentVersion}`) === currentVersion;
const currentLocalTag = localTagCommit(currentTag);
const currentRemoteTag = remoteTagCommit(remote, currentTag);

run("npm", ["whoami", `--registry=${REGISTRY}`], {
  errorMessage: `npm authentication failed; run npm login --registry=${REGISTRY}`,
});

let mode;
let releaseVersion;
let releaseTag;

if (!currentIsPublished && currentLocalTag) {
  assertTagAtHead(currentTag, head);
  mode = "resume-publish";
  releaseVersion = currentVersion;
  releaseTag = currentTag;
} else if (currentIsPublished && !currentRemoteTag && currentLocalTag === head) {
  mode = "resume-push";
  releaseVersion = currentVersion;
  releaseTag = currentTag;
} else if (registryLatest === null) {
  if (currentLocalTag && currentLocalTag !== head) {
    fail(`${currentTag} already exists on a different commit`);
  }
  mode = requestedBump ? "bump" : "initial";
  releaseVersion = requestedBump
    ? incrementVersion(currentVersion, requestedBump)
    : currentVersion;
  releaseTag = `v${releaseVersion}`;
} else {
  if (!currentIsPublished) {
    fail(
      `${name}@${currentVersion} is not published, while npm latest is ${registryLatest}; ` +
        "update your branch before releasing",
    );
  }
  if (registryLatest !== currentVersion) {
    fail(
      `package.json is ${currentVersion}, but npm latest is ${registryLatest}; ` +
        "update your branch before releasing",
    );
  }
  if (!currentRemoteTag) {
    fail(`${currentVersion} is published, but ${currentTag} is missing on ${remote}`);
  }
  mode = "bump";
  const bump = requestedBump ?? "patch";
  releaseVersion = incrementVersion(currentVersion, bump);
  releaseTag = `v${releaseVersion}`;
}

const isRecovery = mode === "resume-publish" || mode === "resume-push";
if (isRecovery) {
  const upstreamIsAncestor = run(
    "git",
    ["merge-base", "--is-ancestor", upstreamHead, head],
    { capture: true, allowFailure: true },
  ).status === 0;
  if (!upstreamIsAncestor) {
    fail(`${branch} has diverged from ${upstream}; resolve it without moving ${releaseTag}`);
  }
} else if (head !== upstreamHead) {
  fail(`${branch} must exactly match ${upstream} before starting a new release`);
}

console.log(`\nPackage: ${name}`);
console.log(`Release: ${currentVersion} -> ${releaseVersion}`);
console.log(`Tag:     ${releaseTag}`);
console.log(`Mode:    ${mode}`);

if (dryRun) {
  console.log("\nRunning release checks without changing Git or publishing...");
  run("npm", ["publish", "--dry-run", `--registry=${REGISTRY}`]);
  console.log(`\nDry run passed. ${releaseTag} was not created or published.`);
  process.exit(0);
}

if (mode === "resume-push") {
  console.log(`\n${name}@${releaseVersion} is already on npm; resuming the Git push...`);
  pushRelease(remote, branch, releaseTag);
  console.log(`\nReleased ${name}@${releaseVersion} and pushed ${releaseTag}.`);
  process.exit(0);
}

if (!isRecovery) {
  console.log("\nRunning the complete project check before creating the release...");
  run("npm", ["run", "check"]);

  if (mode === "bump") {
    const bump = requestedBump ?? "patch";
    run("npm", ["version", bump, "--message=chore(release): v%s"]);
  } else {
    run("git", ["tag", "--annotate", releaseTag, "--message", releaseTag]);
  }
}

const newHead = gitOutput(["rev-parse", "HEAD"]);
assertTagAtHead(releaseTag, newHead);
pushRelease(remote, branch, releaseTag, true);

const publishArgs = ["publish", `--registry=${REGISTRY}`];
if (otp) publishArgs.push(`--otp=${otp}`);

console.log(`\nPublishing ${name}@${releaseVersion}...`);
const publishResult = run("npm", publishArgs, { allowFailure: true });
if (publishResult.status !== 0) {
  const appearedOnRegistry = npmView(`${name}@${releaseVersion}`) === releaseVersion;
  if (!appearedOnRegistry) {
    fail(`npm publish failed; fix the reported problem and run pnpm release again to resume ${releaseTag}`);
  }
  console.log("npm returned an error, but the version is present on the registry; continuing.");
}

console.log(`\nPushing the release commit and ${releaseTag} to ${remote}...`);
pushRelease(remote, branch, releaseTag);
console.log(`\nReleased ${name}@${releaseVersion} and pushed ${releaseTag}.`);
