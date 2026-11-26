import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";

const stage = process.argv[2];
if (stage !== "before" && stage !== "after")
  throw new Error("Use: npm run perf -- before|after");
const env = parseEnv(await readFile(".env", "utf8"));
const base = "http://127.0.0.1:3208";
const server = spawn(process.execPath, [".output/server/index.mjs"], {
  windowsHide: true,
  env: {
    ...process.env,
    DATABASE_URL: env.DATABASE_URL,
    HOST: "127.0.0.1",
    PORT: "3208",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (part: Buffer) => {
  serverLog += part.toString();
});
server.stderr.on("data", (part: Buffer) => {
  serverLog += part.toString();
});
const runs: {
  path: string;
  run: number;
  score: number;
  lcpMs: number;
  cls: number;
  tbtMs: number;
  fcpMs: number;
  ttfbMs: number;
  transferBytes: number;
  scriptBytes: number;
  imageBytes: number;
  decodedScriptBytes: number;
  benchmarkIndex: number;
  lighthouseVersion: string;
  userAgent: string;
}[] = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error(`Performance server stopped: ${serverLog}`);
    try {
      if ((await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Performance server did not start");
  const chrome = await launch({
    chromePath:
      process.env.CHROME_EXECUTABLE ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    chromeFlags: ["--headless=new", "--disable-gpu", "--no-sandbox"],
    logLevel: "silent",
  });
  try {
    for (const path of ["/", "/help", "/articles/kak-sozdat-zayavku"]) {
      const response = await fetch(base + path);
      if (
        response.status !== 200 ||
        !(await response.text()).includes("WorkFlow")
      )
        throw new Error(`Invalid performance page: ${path}`);
      for (let run = 1; run <= 3; run++) {
        const result = await lighthouse(base + path, {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: ["performance"],
          formFactor: "mobile",
          screenEmulation: {
            mobile: true,
            width: 360,
            height: 800,
            deviceScaleFactor: 1,
            disabled: false,
          },
          throttlingMethod: "simulate",
          throttling: {
            rttMs: 150,
            throughputKbps: 1638.4,
            cpuSlowdownMultiplier: 4,
          },
          disableStorageReset: false,
        });
        if (!result) throw new Error("Lighthouse returned no result");
        const lhr = result.lhr;
        if (lhr.runtimeError) throw new Error(lhr.runtimeError.message);
        const network = lhr.audits["network-requests"]!.details;
        const items =
          network?.type === "table"
            ? (network.items as Record<string, unknown>[])
            : [];
        const bytes = (type: string, field = "transferSize") =>
          items
            .filter((item) => item.resourceType === type)
            .reduce((sum, item) => sum + Number(item[field] ?? 0), 0);
        const metric = (name: string) =>
          Number(lhr.audits[name]?.numericValue ?? 0);
        runs.push({
          path,
          run,
          score: Math.round((lhr.categories.performance?.score ?? 0) * 100),
          lcpMs: metric("largest-contentful-paint"),
          cls: metric("cumulative-layout-shift"),
          tbtMs: metric("total-blocking-time"),
          fcpMs: metric("first-contentful-paint"),
          ttfbMs: metric("server-response-time"),
          transferBytes: metric("total-byte-weight"),
          scriptBytes: bytes("Script"),
          imageBytes: bytes("Image"),
          decodedScriptBytes: bytes("Script", "resourceSize"),
          benchmarkIndex: lhr.environment.benchmarkIndex,
          lighthouseVersion: lhr.lighthouseVersion,
          userAgent: lhr.userAgent,
        });
        await mkdir(`.verification/day8/lighthouse/${stage}`, {
          recursive: true,
        });
        const name =
          path === "/"
            ? "landing"
            : path.startsWith("/help")
              ? "help"
              : "article";
        await writeFile(
          `.verification/day8/lighthouse/${stage}/${name}-${run}.json`,
          JSON.stringify(lhr),
        );
        console.log(
          `${stage} ${path} ${run}/3: score ${runs.at(-1)!.score}, LCP ${Math.round(runs.at(-1)!.lcpMs)}ms, JS ${Math.round(runs.at(-1)!.scriptBytes / 1024)} KiB`,
        );
      }
    }
  } finally {
    await chrome.kill();
  }
  const medians = ["/", "/help", "/articles/kak-sozdat-zayavku"].map((path) => {
    const values = runs.filter((run) => run.path === path);
    const median = (key: keyof (typeof values)[number]) =>
      values.map((run) => Number(run[key])).sort((a, b) => a - b)[1]!;
    return {
      path,
      score: median("score"),
      lcpMs: median("lcpMs"),
      cls: median("cls"),
      tbtMs: median("tbtMs"),
      fcpMs: median("fcpMs"),
      ttfbMs: median("ttfbMs"),
      transferBytes: median("transferBytes"),
      scriptBytes: median("scriptBytes"),
      imageBytes: median("imageBytes"),
      decodedScriptBytes: median("decodedScriptBytes"),
    };
  });
  const sourceHash = createHash("sha256")
    .update(await readFile("app/app.vue"))
    .update(await readFile("nuxt.config.ts"))
    .update(await readFile("app/pages/index.vue"))
    .digest("hex");
  await mkdir("docs/performance", { recursive: true });
  await writeFile(
    `docs/performance/${stage}.json`,
    JSON.stringify(
      {
        stage,
        measuredAt: new Date().toISOString(),
        sourceHash,
        environment: {
          node: process.version,
          platform: process.platform,
          viewport: { width: 360, height: 800 },
          rttMs: 150,
          throughputKbps: 1638.4,
          cpuSlowdownMultiplier: 4,
          runs: 3,
          coldCache: true,
        },
        medians,
        runs,
      },
      null,
      2,
    ),
  );
} finally {
  if (server.exitCode === null) {
    const closed = once(server, "exit");
    server.kill();
    await closed;
  }
}
