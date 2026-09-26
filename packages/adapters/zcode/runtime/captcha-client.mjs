/** Runs only in the isolated verification page, using the provider's official SDK. */
export function mountCaptcha(config, token, sdkUrl) {
  const status = document.querySelector("#status");
  const button = document.querySelector("#verify");
  let done = false,
    interactive = false,
    fallback,
    initializing;
  const post = (kind, body = {}) =>
    fetch("/" + kind + "?token=" + token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const show = async (message, trigger = false) => {
    if (done || interactive) return;
    interactive = true;
    clearTimeout(fallback);
    status.textContent = message;
    button.disabled = false;
    await post("interactive");
    if (!done && trigger) button.click();
  };
  const success = async (proof) => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    clearTimeout(initializing);
    button.disabled = true;
    const response = await post("result", { proof });
    status.textContent = response.ok ? "验证已完成，任务将继续。" : "请求已结束。";
  };
  const fail = async () => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    clearTimeout(initializing);
    await post("error");
  };
  document.querySelector("#cancel").onclick = async () => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    clearTimeout(initializing);
    await post("cancel");
  };
  window.addEventListener(
    "pagehide",
    () => {
      if (!done) navigator.sendBeacon("/cancel?token=" + token, "{}");
    },
    { once: true },
  );
  window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
  const script = document.createElement("script");
  script.src = sdkUrl;
  script.onerror = () => {
    void fail();
  };
  script.onload = () => {
    initializing = setTimeout(() => {
      void fail();
    }, 10000);
    try {
      window.initAliyunCaptcha({
        SceneId: config.sceneId,
        mode: "popup",
        language: "cn",
        element: "#captcha",
        button: "#verify",
        getInstance(instance) {
          clearTimeout(initializing);
          // Native Desktop waits briefly after SDK loading before triggering verification.
          setTimeout(() => {
            if (done) return;
            status.textContent = "正在进行账号验证…";
            if (typeof instance.startTracelessVerification === "function") {
              fallback = setTimeout(() => {
                void show("请完成账号验证，完成后任务自动继续。", true);
              }, 8000);
              try {
                instance.startTracelessVerification();
              } catch {
                void fail();
              }
            } else void show("请完成账号验证，完成后任务自动继续。", true);
          }, 2000);
        },
        success,
        fail(value) {
          if (done) return;
          const passed =
            value &&
            typeof value === "object" &&
            ((value.success === true && value.verifyResult === true) ||
              (value.verifyCode ?? value.VerifyCode) === "T006");
          if (passed) {
            const proof = value.captchaVerifyParam ?? value.CaptchaVerifyParam;
            if (typeof proof === "string" && proof.trim()) void success(proof);
            else clearTimeout(fallback); // The SDK may deliver success after this callback.
            return;
          }
          if (value?.success === true && value?.verifyResult === false)
            void show("请完成账号验证，完成后任务自动继续。", true);
          else void fail();
        },
        onError() {
          void fail();
        },
      });
    } catch {
      void fail();
    }
  };
  document.head.append(script);
}
