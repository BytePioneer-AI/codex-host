import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import { installRendererQuestions } from './packages/renderer-extension/src/renderer-questions.ts';
    const question = {interactionId:'ask-1',turnId:'turn-1',title:'Question',questions:[
      {id:'platform',type:'choice',prompt:'Choose platforms',multiple:true,allowOther:true,optional:false,
       options:[{value:'mac',label:'macOS'},{value:'win',label:'Windows'},{value:'linux',label:'Linux'}]},
      {id:'note',type:'text',prompt:'Notes',multiline:true,secret:false,optional:true},
      {id:'priority',type:'choice',prompt:'Priority',multiple:false,allowOther:false,optional:true,
       options:[{value:'high',label:'High'},{value:'low',label:'Low'}]},
    ]};
    const state={questions:[question],thread:'thread-1',host:'local',calls:[],fail:false,listFail:false,hold:false,listHold:false};
    const route={async sendRequest(method,params){
      state.calls.push({method,params});
      if(method.endsWith('/list')) {
        const snapshot=structuredClone(state.questions);
        if(state.listHold) await new Promise(resolve=>state.releaseList=resolve);
        if(state.listFail) throw Error('Disconnected');
        return {questions:snapshot};
      }
      if(state.hold) await new Promise(resolve=>state.release=resolve);
      if(state.fail) throw Error('Rejected');
      state.questions=[]; return {accepted:true};
    }};
    const controller=installRendererQuestions(window,()=>state.thread?{
      hostId:state.host,threadId:state.thread,composer:document.querySelector('#composer'),route
    }:null);
    Object.assign(window,{fixture:state,controller,route});
  `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Question bundle missing");
test.beforeEach(async ({ page }) => {
  await page.route("http://localhost/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><form id="composer"><div contenteditable="true" role="textbox" aria-label="Chat message">chat draft</div></form>',
    }),
  );
  await page.goto("http://localhost/");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("checkbox", { name: "macOS", exact: true })).toBeVisible();
});

test("returns all Host values in mixed groups and leaves the chat editor intact", async ({
  page,
}) => {
  await page.getByRole("checkbox", { name: "macOS", exact: true }).check();
  await page.getByRole("checkbox", { name: "Windows", exact: true }).check();
  await page.getByLabel("Notes", { exact: true }).fill("keep this note");
  await page.getByRole("radio", { name: "High", exact: true }).check();
  await page.evaluate(() => Reflect.get(window, "controller").refresh());
  await expect(page.getByRole("checkbox", { name: "macOS", exact: true })).toBeChecked();
  await expect(page.locator("#composer [data-codexhost-question]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chat message" })).toHaveText("chat draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  const calls = await page.evaluate(() =>
    Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
      c.method.endsWith("/respond"),
    ),
  );
  expect(calls).toEqual([
    {
      method: "codexhost/thread/question/respond",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        interactionId: "ask-1",
        cancelled: false,
        answers: { platform: ["mac", "win"], note: ["keep this note"], priority: ["high"] },
      },
    },
  ]);
});

test("preserves the interaction title with a fallback for untitled questions", async ({ page }) => {
  for (const title of ["Deployment platforms", ""]) {
    await page.evaluate(async (title) => {
      const question = Reflect.get(window, "fixture").questions[0];
      question.title = title;
      question.interactionId = `title-${title || "default"}`;
      await Reflect.get(window, "controller").refresh();
    }, title);
    await expect(page.locator("[data-codexhost-question] .title")).toHaveText(title || "Question");
  }
});

test("validates required and Other answers, retaining drafts after rejection", async ({ page }) => {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("required");
  await page.getByRole("checkbox", { name: "Other: Choose platforms", exact: true }).check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Other");
  await page.getByLabel("Choose platforms: Other", { exact: true }).fill("BSD");
  await page.evaluate(() => {
    Reflect.get(window, "fixture").fail = true;
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not submit");
  await expect(page.getByLabel("Choose platforms: Other", { exact: true })).toHaveValue("BSD");
});

for (const action of ["Skip", "Dismiss question"]) {
  test(`${action} cancels without answers and prevents double submission`, async ({ page }) => {
    await page.getByRole("checkbox", { name: "macOS", exact: true }).check();
    await page.evaluate(() => {
      Reflect.get(window, "fixture").hold = true;
    });
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    const calls = await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
        c.method.endsWith("/respond"),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ answers: {}, cancelled: true });
    await page.evaluate(() => Reflect.get(window, "fixture").release());
    await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  });
}

test("preserves drafts across switching and remounts, but not across owners", async ({ page }) => {
  await page.getByRole("checkbox", { name: "Windows", exact: true }).check();
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").thread = null;
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").thread = "thread-1";
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("checkbox", { name: "Windows", exact: true })).toBeChecked();
  await page.locator("[data-codexhost-question]").evaluate((node) => node.remove());
  await page.evaluate(() => Reflect.get(window, "controller").refresh());
  await expect(page.getByRole("checkbox", { name: "Windows", exact: true })).toBeChecked();
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").host = "remote";
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("checkbox", { name: "Windows", exact: true })).not.toBeChecked();
});

test("withdraws stale cards on failed refresh and native closure", async ({ page }) => {
  await page.getByRole("checkbox", { name: "Windows", exact: true }).check();
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").listFail = true;
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").listFail = false;
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("checkbox", { name: "Windows", exact: true })).toBeChecked();
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").questions = [];
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("does not resurrect an answered card from an older list response", async ({ page }) => {
  await page.evaluate(() => {
    Reflect.get(window, "fixture").listHold = true;
    void Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, "fixture").releaseList());
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("ignores late results on disposal and keeps single-choice-only groups native", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.questions[0].questions[0].multiple = false;
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.get(window, "fixture").listHold = true;
    void Reflect.get(window, "controller").refresh();
    Reflect.get(window, "controller").dispose();
  });
  await page.evaluate(() => Reflect.get(window, "fixture").releaseList());
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("mounts through the real binding probe outside the chat Composer and follows visibility", async ({
  page,
}) => {
  const full = await build({
    stdin: {
      contents: `
      import {installRendererBindingProbe} from './packages/renderer-extension/src/renderer-binding-probe.ts';
      import {encodeHarnessPluginRoute} from '@codexhost/shared-contracts';
      window.__codexhostHostRoutingV1={forHost:()=>({hostId:'local',manager:window.route})};
      const editor=document.querySelector('[contenteditable]');
      Object.defineProperty(editor,'__reactFiber$test',{value:{memoizedProps:{isOrbit:false},return:null}});
      const binding=installRendererBindingProbe({enabledAgents:['codex','pi'],defaultAgent:'pi'});
      const transportModelId=encodeHarnessPluginRoute({harnessId:'pi',model:{id:'test'}});
      const client=new Proxy({}, {get:(_,key)=>{
        if(key==='currentHostId') return ()=>'local';
        if(key==='clientForHost'||key==='knownHostIds') return undefined;
        if(String(key).startsWith('subscribe')) return ()=>()=>{};
        if(key==='inspectThread') return async()=>({owner:'external',harnessId:'pi',locked:true,transportModelId,history:{fork:false,forkAcrossCwd:false,rollbackLastTurn:false}});
        if(key==='listHarnessPlugins') return async()=>({plugins:[{id:'pi',name:'Pi',version:'1.0.0'}]});
        return async()=>{throw Error('Unused fixture method');};
      }});
      binding.setAdapter({state:'ready',reason:'ready',modelUpdates:0,hook:'request-bridge'},undefined,()=>true,client);
      window.binding=binding;
    `,
      resolveDir: path.resolve(import.meta.dirname, "../.."),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  });
  await page.evaluate(() => Reflect.get(window, "controller").dispose());
  await page.setContent(
    '<form id="composer" data-codex-composer-root><div data-above-composer-portal data-above-composer-conversation-id="thread-1"></div><div contenteditable="true" role="textbox">chat draft</div><button type="submit">Send</button></form>',
  );
  const fullBundle = full.outputFiles[0]?.text;
  if (!fullBundle) throw new Error("Binding bundle missing");
  await page.addScriptTag({ content: fullBundle });
  await expect(page.getByRole("checkbox", { name: "macOS", exact: true })).toBeVisible();
  await expect(page.locator("#composer textarea")).toHaveCount(0);
  await page.getByLabel("Notes", { exact: true }).fill("keep draft");
  await page.locator("#composer").evaluate((node) => {
    (node as HTMLElement).hidden = true;
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.locator("#composer").evaluate((node) => {
    (node as HTMLElement).hidden = false;
  });
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("keep draft");
  // Native question/approval surfaces temporarily own the Composer; do not stack a shared card.
  await page
    .locator("#composer")
    .evaluate((node) => node.setAttribute("data-codex-composer-request", ""));
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await page
    .locator("#composer")
    .evaluate((node) => node.removeAttribute("data-codex-composer-request"));
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("keep draft");
  await page.evaluate(() => Reflect.get(window, "binding").dispose());
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

for (const scheme of ["light", "dark"]) {
  test(`keyboard selection and visible controls survive Desktop CSS resets (${scheme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 760, height: 800 });
    await page.addStyleTag({
      content: `:root{color-scheme:${scheme}}body{margin:24px;background:${scheme === "dark" ? "#1b1b1b" : "#fff"}} input,button{appearance:none;border:0;padding:0;background:transparent}fieldset,legend{padding:0;margin:0}`,
    });
    const mac = page.getByRole("checkbox", { name: "macOS", exact: true });
    await mac.focus();
    await expect(mac).toBeFocused();
    await mac.press("Space");
    await page.getByRole("checkbox", { name: "Windows", exact: true }).check();
    await expect(mac).toBeChecked();
    expect(
      await mac.evaluate((input) => input.getBoundingClientRect().width),
    ).toBeGreaterThanOrEqual(20);
    await expect(
      page.locator(".option:has(input:checked) .selected-indicator").first(),
    ).toBeVisible();
    await page
      .locator("[data-codexhost-question]")
      .screenshot({ path: testInfo.outputPath(`multiselect-${scheme}.png`) });
    await page.setViewportSize({ width: 360, height: 480 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  });
}
