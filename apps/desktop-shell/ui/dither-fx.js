/* CodexHost Desktop Shell — Native Bayer Ordered-Dither Micro-FX.
 * Pure 2D Canvas, zero external dependencies, strict offline CSP compliant. */
(function () {
  "use strict";

  var BAYER = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ].map(function (v) {
    return (v + 0.5) / 64;
  });

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function easeOutCubic(x) {
    return 1 - Math.pow(1 - clamp01(x), 3);
  }

  function hash(x, y, s) {
    var v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
    return v - Math.floor(v);
  }

  function isDarkTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") {
      return true;
    }
    if (attr === "light") {
      return false;
    }
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function getPalette(status) {
    var dark = isDarkTheme();
    if (status === "reconnecting") {
      return dark
        ? {
            bg: [8, 16, 45],
            c1: [30, 38, 72],
            c2: [148, 106, 36],
            c3: [240, 178, 72],
            c4: [255, 240, 204],
          }
        : {
            bg: [247, 243, 236],
            c1: [238, 224, 198],
            c2: [212, 152, 52],
            c3: [154, 101, 16],
            c4: [84, 52, 8],
          };
    }
    if (status === "error") {
      return dark
        ? {
            bg: [8, 16, 45],
            c1: [42, 24, 56],
            c2: [156, 56, 68],
            c3: [244, 108, 108],
            c4: [255, 224, 224],
          }
        : {
            bg: [247, 243, 236],
            c1: [244, 218, 218],
            c2: [204, 78, 78],
            c3: [164, 44, 44],
            c4: [96, 22, 22],
          };
    }
    return dark
      ? {
          bg: [9, 17, 49],
          c1: [19, 44, 96],
          c2: [28, 134, 128],
          c3: [76, 229, 190],
          c4: [238, 251, 247],
        }
      : {
          bg: [247, 242, 235],
          c1: [214, 234, 226],
          c2: [42, 168, 136],
          c3: [22, 62, 110],
          c4: [12, 29, 58],
        };
  }

  /* Beat 1a: Non-blocking 0.75s holographic Bayer pixel reveal on hero artwork */
  function playHeroMaterialize(canvas, durationMs) {
    if (!canvas || prefersReducedMotion()) {
      if (canvas) {
        canvas.hidden = true;
      }
      return function () {};
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.hidden = true;
      return function () {};
    }
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(48, Math.round(rect.width || window.innerWidth * 0.52));
    var h = Math.max(48, Math.round(rect.height || window.innerHeight));
    var cell = Math.max(4, Math.round(Math.min(w, h) / 118));
    var gw = Math.max(12, Math.ceil(w / cell));
    var gh = Math.max(12, Math.ceil(h / cell));
    canvas.width = gw;
    canvas.height = gh;
    canvas.hidden = false;

    var img = ctx.createImageData(gw, gh);
    var data = img.data;
    var cx = gw * 0.44;
    var cy = gh * 0.45;
    var maxD = Math.hypot(gw, gh) * 0.72;
    var dur = durationMs || 760;
    var rafId = null;
    var t0 = 0;

    function frame(now) {
      if (!t0) {
        t0 = now;
      }
      var p = clamp01((now - t0) / dur);
      var wave = easeOutCubic(p) * 1.38;
      var pal = getPalette("starting");
      var f = Math.floor((now - t0) / 50);

      for (var y = 0; y < gh; y += 1) {
        var row = (y & 7) * 8;
        for (var x = 0; x < gw; x += 1) {
          var i = y * gw + x;
          var th = BAYER[row + (x & 7)];
          var d = (0.55 * Math.hypot(x - cx, y - cy)) / maxD + 0.45 * (1 - y / gh);
          var k = (wave - d) * 4.5;
          var a = 255;
          var col = pal.bg;
          if (k > th) {
            a = 0;
          } else if (k > th - 0.22) {
            col = pal.c4;
            a = 230;
          } else if (k > th - 0.54) {
            col = pal.c3;
            a = 210;
          } else if (k > th - 0.88) {
            col = pal.c2;
            a = 232;
          } else if (hash(x, y, f) < 0.036) {
            col = pal.c1;
          }
          var o = i * 4;
          data[o] = col[0];
          data[o + 1] = col[1];
          data[o + 2] = col[2];
          data[o + 3] = a;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (p >= 1) {
        canvas.hidden = true;
        return;
      }
      rafId = window.requestAnimationFrame(frame);
    }

    rafId = window.requestAnimationFrame(frame);
    return function cancel() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      canvas.hidden = true;
    };
  }

  /* Beat 1b: Ultra-subtle cursor-reactive Bayer micro-particles on right pane (calm when idle) */
  function startCursorMicroDither(canvas) {
    if (!canvas || prefersReducedMotion()) {
      if (canvas) {
        canvas.hidden = true;
      }
      return function () {};
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      return function () {};
    }
    var cell = 5;
    var gw = 1;
    var gh = 1;
    var img = null;
    var mx = -999;
    var my = -999;
    var smx = -999;
    var smy = -999;
    var energy = 0;
    var rafId = null;
    var lastDraw = 0;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var w = Math.max(40, Math.round(rect.width || window.innerWidth * 0.48));
      var h = Math.max(40, Math.round(rect.height || window.innerHeight));
      gw = Math.max(16, Math.ceil(w / cell));
      gh = Math.max(16, Math.ceil(h / cell));
      canvas.width = gw;
      canvas.height = gh;
      img = ctx.createImageData(gw, gh);
    }

    function onMove(e) {
      var rect = canvas.getBoundingClientRect();
      var nx = (e.clientX - rect.left) / cell;
      var ny = (e.clientY - rect.top) / cell;
      if (nx < -12 || nx > gw + 12 || ny < -12 || ny > gh + 12) {
        return;
      }
      mx = nx;
      my = ny;
      if (smx < -500) {
        smx = mx;
        smy = my;
      }
      energy = 1;
      if (rafId === null) {
        rafId = window.requestAnimationFrame(tick);
      }
    }

    function tick(now) {
      rafId = null;
      if (!img) {
        return;
      }
      if (now - lastDraw >= 36) {
        lastDraw = now;
        var pal = getPalette("starting");
        var dark = isDarkTheme();
        var data = img.data;
        if (mx > -500) {
          smx += (mx - smx) * 0.22;
          smy += (my - smy) * 0.22;
        }
        energy *= 0.94;
        var rad = 25;

        for (var y = 0; y < gh; y += 1) {
          var row = (y & 7) * 8;
          for (var x = 0; x < gw; x += 1) {
            var i = y * gw + x;
            var o = i * 4;
            var d = Math.hypot(x - smx, y - smy) / rad;
            if (d >= 1.3 || energy < 0.025) {
              data[o + 3] = 0;
              continue;
            }
            var th = BAYER[row + (x & 7)];
            var b = Math.exp(-d * d * 2.4) * 0.54 * energy;
            if (b > th * 0.9) {
              var col = b > 0.36 ? pal.c4 : pal.c3;
              data[o] = col[0];
              data[o + 1] = col[1];
              data[o + 2] = col[2];
              data[o + 3] = dark ? 96 : 74;
            } else if (b > th * 0.56) {
              data[o] = pal.c2[0];
              data[o + 1] = pal.c2[1];
              data[o + 2] = pal.c2[2];
              data[o + 3] = dark ? 44 : 34;
            } else {
              data[o + 3] = 0;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      if (energy >= 0.02) {
        rafId = window.requestAnimationFrame(tick);
      }
    }

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });

    return function stop() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }

  /* Beat 1c: Living Bayer pixel-stardust seam ribbon bridging hero artwork & right action pane */
  function startSeamDither(canvas) {
    if (!canvas || prefersReducedMotion()) {
      if (canvas) {
        canvas.hidden = true;
      }
      return function () {};
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      return function () {};
    }
    var gw = 40;
    var gh = 176;
    canvas.width = gw;
    canvas.height = gh;
    var img = ctx.createImageData(gw, gh);
    var data = img.data;
    var rafId = null;
    var lastDraw = 0;

    function tick(now) {
      if (now - lastDraw >= 55) {
        lastDraw = now;
        var t = now / 1000;
        var pal = getPalette("starting");
        var dark = isDarkTheme();

        for (var y = 0; y < gh; y += 1) {
          var row = (y & 7) * 8;
          var yn = y / gh;
          var drift = Math.sin(yn * 8.5 - t * 1.1) * 0.13 + Math.cos(yn * 4.5 + t * 0.65) * 0.07;
          for (var x = 0; x < gw; x += 1) {
            var i = y * gw + x;
            var th = BAYER[row + (x & 7)];
            var xn = x / (gw - 1);
            // Smooth edge taper so pixels dissolve organically with zero hard canvas edge
            var edgeFade = Math.sin(Math.PI * xn);
            var band =
              Math.exp(-Math.pow((xn - (0.5 + drift)) / 0.23, 2)) * Math.min(1, edgeFade * 2.1);
            var sparkle = hash(x, Math.floor(y + t * 4), 11);
            var intensity =
              band * (0.28 + 0.16 * Math.sin(t * 1.55 + y * 0.18)) +
              (sparkle > 0.962 ? band * 0.68 : 0);
            var a = 0;
            var col = pal.c3;
            if (intensity > th * 0.9) {
              col = intensity > 0.54 ? pal.c4 : pal.c3;
              a = dark ? 122 : 90;
            } else if (intensity > th * 0.5) {
              col = pal.c2;
              a = dark ? 56 : 42;
            }
            var o = i * 4;
            data[o] = col[0];
            data[o + 1] = col[1];
            data[o + 2] = col[2];
            data[o + 3] = a;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      rafId = window.requestAnimationFrame(tick);
    }

    rafId = window.requestAnimationFrame(tick);
    return function stop() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }

  /* Beat 2a: Crisp 0.35s inward Bayer pixel converge when launching Native Shell */
  function playInwardConverge(canvas, durationMs, onDone) {
    if (!canvas || prefersReducedMotion()) {
      if (onDone) {
        onDone();
      }
      return function () {};
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      if (onDone) {
        onDone();
      }
      return function () {};
    }
    var cell = Math.max(4, Math.round(Math.min(window.innerWidth, window.innerHeight) / 165));
    var gw = Math.max(16, Math.ceil(window.innerWidth / cell));
    var gh = Math.max(16, Math.ceil(window.innerHeight / cell));
    canvas.width = gw;
    canvas.height = gh;
    canvas.hidden = false;
    var img = ctx.createImageData(gw, gh);
    var data = img.data;
    var cx = gw / 2;
    var cy = gh * 0.4;
    var maxD = Math.hypot(cx, Math.max(cy, gh - cy));
    var dur = durationMs || 350;
    var rafId = null;
    var t0 = 0;

    function frame(now) {
      if (!t0) {
        t0 = now;
      }
      var p = clamp01((now - t0) / dur);
      var pal = getPalette("starting");
      var f = Math.floor((now - t0) / 40);
      var front = 1.24 - easeOutCubic(p) * 1.48;

      for (var y = 0; y < gh; y += 1) {
        var row = (y & 7) * 8;
        for (var x = 0; x < gw; x += 1) {
          var i = y * gw + x;
          var th = BAYER[row + (x & 7)];
          var d = Math.hypot(x - cx, (y - cy) * 1.25) / maxD;
          var k = (d - front) * 4.5;
          var a = 0;
          var col = pal.bg;
          if (k > th) {
            a = 255;
            if (k < th + 0.25) {
              col = pal.c4;
            } else if (k < th + 0.62) {
              col = pal.c3;
            } else if (k < th + 1.0) {
              col = pal.c2;
            } else {
              col = hash(x, y, f) < 0.04 ? pal.c1 : pal.bg;
            }
          }
          var o = i * 4;
          data[o] = col[0];
          data[o + 1] = col[1];
          data[o + 2] = col[2];
          data[o + 3] = a;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (p >= 1) {
        if (onDone) {
          onDone();
        }
        return;
      }
      rafId = window.requestAnimationFrame(frame);
    }

    rafId = window.requestAnimationFrame(frame);
    return function cancel() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      canvas.hidden = true;
    };
  }

  /* Beat 2b: Airy translucent Bayer orbital rings + subtle stardust behind Chibi Otter on loading.html */
  function startLoadingOrbitalDither(canvas, getStatus) {
    if (!canvas || prefersReducedMotion()) {
      if (canvas) {
        canvas.hidden = true;
      }
      return function () {};
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      return function () {};
    }
    var cell = 5;
    var gw = 1;
    var gh = 1;
    var img = null;
    var rafId = null;
    var lastDraw = 0;

    function resize() {
      cell = Math.max(4, Math.round(Math.min(window.innerWidth, window.innerHeight) / 155));
      gw = Math.max(24, Math.ceil(window.innerWidth / cell));
      gh = Math.max(24, Math.ceil(window.innerHeight / cell));
      canvas.width = gw;
      canvas.height = gh;
      img = ctx.createImageData(gw, gh);
    }

    function tick(now) {
      if (now - lastDraw >= 45 && img) {
        lastDraw = now;
        var t = now / 1000;
        var status = getStatus ? getStatus() : "starting";
        var pal = getPalette(status);
        var dark = isDarkTheme();
        var data = img.data;
        var cx = gw / 2;
        var cy = status === "error" ? gh * 0.27 : gh * 0.37;
        var R = Math.min(gw, gh) * (status === "error" ? 0.24 : 0.32);
        var speed = status === "error" ? 0.2 : status === "reconnecting" ? 1.35 : 0.8;
        var f = Math.floor(t * 10);

        for (var y = 0; y < gh; y += 1) {
          var row = (y & 7) * 8;
          for (var x = 0; x < gw; x += 1) {
            var i = y * gw + x;
            var th = BAYER[row + (x & 7)];
            var dx = (x - cx) / R;
            var dy = (y - cy) / R;
            var rr = dx * dx + dy * dy;
            var r = Math.sqrt(rr);

            var ring1 = Math.exp(-Math.pow((r - 0.86) / 0.052, 2));
            var ring2 = Math.exp(-Math.pow((r - 1.24) / 0.044, 2)) * 0.62;
            var ang = Math.atan2(dy, dx) + t * speed * 0.68;
            var arcMod = 0.55 + 0.45 * Math.sin(ang * 3);
            var coreGlow = Math.exp(-rr * 1.55) * (0.36 + 0.07 * Math.sin(t * 2.1));
            var b =
              coreGlow +
              ring1 * (0.44 + 0.32 * arcMod) +
              ring2 * (0.3 + 0.32 * Math.cos(ang * 2 - t));

            if (status === "error") {
              b *= 0.55;
            }

            var dust = hash(x, y, 17);
            if (dust < 0.0045) {
              b += 0.28 * (0.5 + 0.5 * Math.sin(t * 2.2 + x * 0.7 + y * 0.3));
            } else {
              b += (hash(x, y, f) - 0.5) * 0.035;
            }

            if (y > gh * 0.58) {
              b *= Math.max(0.18, 1 - (y - gh * 0.58) / (gh * 0.42));
            }

            var v = clamp01(b) * 3;
            var lo = Math.floor(v);
            var fr = v - lo;
            var level = Math.min(3, lo + (fr > th ? 1 : 0));
            var col = level === 0 ? pal.bg : level === 1 ? pal.c1 : level === 2 ? pal.c2 : pal.c3;
            var alpha =
              level === 0
                ? 0
                : level === 1
                  ? dark
                    ? 98
                    : 68
                  : level === 2
                    ? dark
                      ? 124
                      : 92
                    : dark
                      ? 156
                      : 116;

            var o = i * 4;
            data[o] = col[0];
            data[o + 1] = col[1];
            data[o + 2] = col[2];
            data[o + 3] = alpha;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      rafId = window.requestAnimationFrame(tick);
    }

    resize();
    window.addEventListener("resize", resize);
    rafId = window.requestAnimationFrame(tick);

    return function stop() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener("resize", resize);
    };
  }

  window.CodexHostDitherFX = {
    playHeroMaterialize: playHeroMaterialize,
    startCursorMicroDither: startCursorMicroDither,
    startSeamDither: startSeamDither,
    playInwardConverge: playInwardConverge,
    startLoadingOrbitalDither: startLoadingOrbitalDither,
  };
})();
