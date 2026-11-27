// Wefty site: the live timeline band, the thread that runs through the page, the screenshot
// tabs, and download links that always point at the latest release.

(() => {
  const REPO = "CodeStrate/Wefty";
  const RELEASES = `https://github.com/${REPO}/releases/latest`;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Live timeline band ---------- */

  const canvas = document.getElementById("river");
  const ctx = canvas.getContext("2d");

  const COLORS = { claude: "#e5732e", codex: "#3b8eea", cursor: "#9a6fd6", opencode: "#3aa676" };
  const NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "Opencode" };
  const PROJECTS = ["ios-app", "billing-service", "acme-api", "docs-site", "infra"];
  const TITLES = [
    "Offline sync conflict handling", "Proration for mid-cycle upgrades", "Per-IP rate limiting",
    "Migrate session cookies to JWT", "Fix flaky auth tests", "Quickstart rewrite",
    "Full-text search with Pagefind", "Invoice PDF rendering", "Stripe webhook idempotency",
    "Background refresh", "Inbox empty state", "Retry queue for exports", "Dark mode tokens",
    "Cold start profiling", "Release notes script", "Flaky upload on 3G",
  ];
  const MEMORIES = ["CLAUDE.md", "AGENTS.md", "Memory Index", "Auth decisions", "API conventions", "Proration rules"];

  const SPEED = 32; // px per second: quick enough to read as live, slow enough to read the titles
  const BAND = 150; // width of a "day" column
  const TOP = 46;

  let width = 0;
  let height = 0;
  let laneH = 72;
  let nowX = 0;
  let camera = 1400;
  let lanes = [];
  let seed = 11;

  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (min, max) => min + rand() * (max - min);

  function harness() {
    const r = rand();
    return r < 0.52 ? "claude" : r < 0.82 ? "codex" : r < 0.92 ? "cursor" : "opencode";
  }

  /** Adds sessions and memories to a lane until it reaches `until` (world x). */
  function extend(lane, until) {
    while (lane.next < until) {
      const start = lane.next;
      const kind = harness();
      const length = between(150, 430);
      const session = { start, end: start + length, kind, title: pick(TITLES), room: Infinity };
      if (lane.last) lane.last.room = start - lane.last.start - 14;
      lane.items.push(session);
      let end = session.end;
      // Some sessions stop at a usage limit and the same work continues in another agent.
      if ((kind === "claude" || kind === "codex") && rand() < 0.34) {
        session.limited = true;
        const next = kind === "claude" ? "codex" : "claude";
        const after = {
          start: end + 40, end: end + 40 + between(150, 330), kind: next,
          title: session.title, continued: true, room: Infinity,
        };
        session.room = after.start - start - 14;
        lane.items.push(after);
        lane.last = after;
        end = after.end;
      } else {
        lane.last = session;
      }
      if (rand() < 0.7) lane.items.push({ memory: true, x: start + between(20, length), title: pick(MEMORIES) });
      lane.next = end + between(90, 320);
    }
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    nowX = Math.round(width * 0.8);
    const count = width < 860 ? 3 : 4;
    laneH = (height - TOP - 20) / count;
    while (lanes.length < count) {
      lanes.push({ name: PROJECTS[lanes.length], items: [], next: camera - width - between(0, 300) });
    }
    lanes.length = count;
    for (const lane of lanes) extend(lane, camera + width);
  }

  const screenX = (worldX) => worldX - camera + nowX;

  function label(text, x, y, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  /** An expanding, fading ring: `t` runs from 0 (start) to 1 (gone). */
  function ring(x, y, t, rgb) {
    ctx.strokeStyle = `rgba(${rgb},${0.9 * (1 - t)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5 + t * 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(${rgb},${0.35 * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(x, y, 5 + t * 10, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = "middle";

    // Day columns, like the app's timeline.
    const first = Math.floor((camera - nowX) / BAND);
    for (let i = first; screenX(i * BAND) < width; i++) {
      if (i % 2 === 0) continue;
      ctx.fillStyle = "rgba(170,166,176,0.03)";
      ctx.fillRect(screenX(i * BAND), TOP - 10, BAND, height - TOP);
    }

    lanes.forEach((lane, index) => {
      const y = TOP + index * laneH;
      ctx.fillStyle = "rgba(170,166,176,0.09)";
      ctx.fillRect(0, y + laneH - 1, width, 1);

      for (const item of lane.items) {
        ctx.font = '500 11.5px "Inter", ui-sans-serif, system-ui, sans-serif';
        if (item.memory) {
          const x = screenX(item.x);
          if (item.x > camera || x < -200) continue;
          const my = y + laneH - 16;
          ctx.save();
          ctx.translate(x, my);
          ctx.rotate(Math.PI / 4);
          ctx.strokeStyle = "rgba(229,166,178,0.6)";
          ctx.lineWidth = 1.4;
          ctx.strokeRect(-3.5, -3.5, 7, 7);
          ctx.restore();
          ctx.fillStyle = "#aaa6b0";
          label(item.title, x + 10, my, 0.6);
          continue;
        }
        if (item.start > camera) continue;
        const x0 = screenX(item.start);
        const x1 = screenX(Math.min(item.end, camera));
        if (x1 < -300) continue;
        const by = y + 30;

        ctx.fillStyle = COLORS[item.kind];
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.roundRect(x0, by - 4, Math.max(6, x1 - x0), 8, 4);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Titles stop short of the next session in the lane.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, by - 26, item.room, 20);
        ctx.clip();
        ctx.fillStyle = "#faf8fa";
        label(item.continued ? `${item.title} · continued in ${NAMES[item.kind]}` : item.title, x0, by - 15, 0.62);
        ctx.restore();

        if (item.end > camera && !reduceMotion) {
          const pulse = 0.5 + 0.5 * Math.sin(time / 260);
          ctx.fillStyle = COLORS[item.kind];
          ctx.globalAlpha = 0.25 + 0.35 * pulse;
          ctx.beginPath();
          ctx.arc(x1, by, 7 + 3 * pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        if (item.limited && item.end <= camera) {
          // The stop: a crimson tick, then a cyan handoff link to where the next agent picks up.
          const xe = screenX(item.end);
          const since = (camera - item.end) / SPEED; // seconds since the limit was hit
          if (since < 1.4 && !reduceMotion) ring(xe + 3, by, since / 1.4, "186,20,52");
          ctx.fillStyle = "#ba1434";
          ctx.fillRect(xe + 2, by - 9, 2.5, 18);
          ctx.font = '500 10.5px "Geist Mono", ui-monospace, monospace';
          ctx.fillStyle = "#e5a6b2";
          label("usage limit", xe + 8, by + 15, Math.min(0.9, since * 1.5));
          ctx.strokeStyle = "#1fcee7";
          ctx.globalAlpha = 0.85;
          ctx.setLineDash([3, 4]);
          ctx.lineDashOffset = reduceMotion ? 0 : -time / 45; // the dashes march toward the next agent
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(xe + 6, by);
          ctx.lineTo(Math.min(screenX(item.end + 40), nowX), by);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          ctx.globalAlpha = 1;
        }

        if (item.continued && !reduceMotion) {
          // The next agent picks up: a cyan glow where its session begins.
          const since = (camera - item.start) / SPEED;
          if (since >= 0 && since < 1.6) ring(x0, by, since / 1.6, "31,206,231");
        }
      }
    });

    // Lane names, over a fade so titles never cover them.
    const fade = ctx.createLinearGradient(0, 0, width * 0.2, 0);
    fade.addColorStop(0, "rgba(11,11,13,0.95)");
    fade.addColorStop(0.75, "rgba(11,11,13,0.6)");
    fade.addColorStop(1, "rgba(11,11,13,0)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, width * 0.2, height);
    // Lane names sit on a small ink plate, so session titles running under them stay out of the way.
    ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
    lanes.forEach((lane, index) => {
      const x = Math.max(16, width * 0.1);
      const y = TOP + index * laneH + 30;
      const w = ctx.measureText(lane.name).width;
      ctx.fillStyle = "rgba(11,11,13,0.92)";
      ctx.beginPath();
      ctx.roundRect(x - 8, y - 11, w + 16, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#aaa6b0";
      label(lane.name, x, y, 0.9);
    });

    // The now line.
    ctx.strokeStyle = "rgba(31,206,231,0.35)";
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(nowX + 0.5, 10);
    ctx.lineTo(nowX + 0.5, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '500 10px "Geist Mono", ui-monospace, monospace';
    ctx.fillStyle = "#1fcee7";
    label("now", nowX + 6, 18, 0.75);
  }

  function prune() {
    const limit = camera - nowX - 600;
    for (const lane of lanes) {
      lane.items = lane.items.filter((item) => (item.memory ? item.x : item.end) > limit);
      extend(lane, camera + width);
    }
  }

  let visible = true;
  let last = 0;
  let frames = 0;
  function frame(time) {
    requestAnimationFrame(frame);
    if (document.hidden || !visible) return (last = 0);
    // First frame (or back from hidden): just note the time, so the next frame has a real delta.
    if (!last) return (last = time);
    const delta = Math.min(time - last, 100);
    if (delta < 1000 / 40) return; // ~40 fps is plenty for a slow drift
    last = time;
    camera += (SPEED * delta) / 1000;
    if (++frames % 120 === 0) prune();
    draw(time);
  }

  resize();
  draw(0);
  addEventListener("resize", () => {
    resize();
    draw(performance.now());
  });
  if (!reduceMotion) {
    new IntersectionObserver(([entry]) => (visible = entry.isIntersecting)).observe(canvas);
    requestAnimationFrame(frame);
  }

  /* ---------- The thread ---------- */

  const flow = document.getElementById("flow");
  const thread = flow.querySelector(".thread");
  const base = thread.querySelector(".base");
  const fill = thread.querySelector(".fill");
  const start = document.querySelector(".river-foot .node");
  const nodes = [start, ...flow.querySelectorAll(".step > .node")];
  let length = 0;

  function center(node) {
    const box = node.getBoundingClientRect();
    const origin = flow.getBoundingClientRect();
    return { x: box.left + box.width / 2 - origin.left, y: box.top + box.height / 2 - origin.top };
  }

  /**
   * A path through every marker that stays in the margins: straight down past a section, then
   * across in the empty space above the next one, then down into its marker.
   */
  let points = [];
  /** Length along the thread at which it reaches each marker. */
  let marks = [];

  function layout() {
    points = nodes.map(center);
    let d = `M ${points[0].x} ${points[0].y}`;
    marks = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.abs(a.x - b.x) < 2) {
        d += ` L ${b.x} ${b.y}`;
      } else {
        const turn = Math.max(a.y + 20, b.y - 96);
        d += ` L ${a.x} ${turn} C ${a.x} ${turn + 40}, ${b.x} ${turn + 22}, ${b.x} ${turn + 64} L ${b.x} ${b.y}`;
      }
      // Measure the thread up to this marker, so the fill can stop exactly on it.
      fill.setAttribute("d", d);
      marks.push(fill.getTotalLength());
    }
    base.setAttribute("d", d);
    fill.setAttribute("d", d);
    length = fill.getTotalLength();
    fill.style.strokeDasharray = `${length}`;
    progress();
  }

  /**
   * Fill the thread up to a reading line 60% down the window. A marker lights exactly when the
   * fill reaches it, and at the bottom of the page everything is lit, so the line always arrives.
   */
  function progress() {
    const origin = flow.getBoundingClientRect().top;
    const line = innerHeight * 0.6 - origin; // the reading line, in thread coordinates
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    let filled = 0;
    if (atBottom) filled = length;
    else {
      for (let i = 0; i < points.length; i++) {
        if (line < points[i].y) {
          // Between marker i - 1 and marker i: fill that share of the stretch between them.
          if (i > 0) {
            const share = (line - points[i - 1].y) / (points[i].y - points[i - 1].y);
            filled = marks[i - 1] + Math.max(0, share) * (marks[i] - marks[i - 1]);
          }
          break;
        }
        filled = marks[i];
      }
    }
    fill.style.strokeDashoffset = `${length - filled}`;
    nodes.forEach((node, i) => node.classList.toggle("on", filled >= marks[i] - 0.5 && filled > 0));
  }

  // Images, web fonts, and the download buttons all arrive after the first layout and move the
  // markers, so redraw on any size change instead of a fixed list of events.
  let pending = false;
  new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      layout();
    });
  }).observe(document.body);
  addEventListener("scroll", progress, { passive: true });

  /* ---------- Nav and reveals ---------- */

  const bar = document.querySelector(".bar");
  const onScroll = () => bar.classList.toggle("scrolled", scrollY > 8);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });

  // Each section's content rises in once. The markers stay put, so the thread never moves.
  const revealed = document.querySelectorAll(".step > :not(.node)");
  if (!reduceMotion && "IntersectionObserver" in window) {
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          reveal.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const element of revealed) {
      element.classList.add("reveal");
      reveal.observe(element);
    }
  }

  /* ---------- Screenshot tabs ---------- */

  const SHOTS = {
    timeline: ["img/timeline.png", "Wefty's timeline: one lane per project, sessions coloured by agent, memory files as diamonds",
      "Timeline: one lane per project. Bars are sessions, coloured by agent; diamonds are memory files at their last edit."],
    graph: ["img/graph.png", "Wefty's graph: projects as hubs with their sessions and memories around them",
      "Graph: each project is a hub with its sessions and memories. Links show which sessions read or wrote which memory."],
    session: ["img/handoff-menu.png", "A session open beside the timeline, with the handoff menu showing Continue in Claude Code and Continue in Codex",
      "Session: the full transcript, searchable. Its menu copies a handoff or continues the work in another agent."],
    memory: ["img/memory.png", "A memory file open in Wefty, with its project, location, and contents",
      "Memory: read and edit memory files in place, see where they apply and what links to them."],
  };
  const img = document.getElementById("shot-img");
  const cap = document.getElementById("shot-cap");
  const tabs = [...document.querySelectorAll("[data-shot]")];
  for (const [src] of Object.values(SHOTS)) new Image().src = src;
  const tabList = document.querySelector(".tabs");
  const TAB_MS = 5000;
  let swap = 0;
  function select(tab) {
    const [src, alt, caption] = SHOTS[tab.dataset.shot];
    for (const other of tabs) other.setAttribute("aria-selected", String(other === tab));
    cap.textContent = caption;
    if (reduceMotion) {
      img.src = src;
      img.alt = alt;
      return;
    }
    // Crossfade: fade out, swap the picture, fade back in.
    clearTimeout(swap);
    img.classList.add("swapping");
    swap = setTimeout(() => {
      img.src = src;
      img.alt = alt;
      img.classList.remove("swapping");
    }, 200);
  }

  // Auto-advance while the section is on screen; any click or key stops it for good.
  let auto = !reduceMotion;
  let timer = 0;
  tabList.style.setProperty("--tab-ms", `${TAB_MS}ms`);
  function schedule() {
    clearTimeout(timer);
    if (!auto) return;
    tabList.classList.remove("auto");
    void tabList.offsetWidth; // restart the progress bar
    tabList.classList.add("auto");
    timer = setTimeout(() => {
      const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
      select(tabs[(current + 1) % tabs.length]);
      schedule();
    }, TAB_MS);
  }
  function stopAuto() {
    auto = false;
    clearTimeout(timer);
    tabList.classList.remove("auto");
  }
  if (auto) {
    new IntersectionObserver(([entry]) => {
      if (!auto) return;
      if (entry.isIntersecting) schedule();
      else {
        clearTimeout(timer);
        tabList.classList.remove("auto");
      }
    }).observe(document.getElementById("look"));
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      stopAuto();
      select(tab);
    });
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      stopAuto();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      select(next);
    });
  });

  /* ---------- Downloads ---------- */

  const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2v8.5M4.2 7 8 10.8 11.8 7M3 13.5h10"/></svg>';
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "win" : /Linux|X11/.test(ua) && !/Android/.test(ua) ? "linux" : null;
  const TARGETS = [
    { os: "mac", label: "Download for macOS", note: "Apple Silicon", match: /\.dmg$/ },
    { os: "win", label: "Download for Windows", note: "", match: /Setup.*\.exe$/ },
    {
      os: "linux",
      label: "Download for Linux",
      note: "AppImage",
      match: /\.AppImage$/,
      alt: { key: "deb", short: ".deb", label: ".deb package for Debian and Ubuntu", match: /_amd64\.deb$/ } 
    },
  ];

  function render(urls) {
    const ordered = [...TARGETS].sort((a, b) => (b.os === os) - (a.os === os));
    const html = ordered
      .map((target) => {
        const primary = target.os === (os ?? "mac") ? " primary" : "";
        const note = target.note ? ` <small>${target.note}</small>` : "";
        const button = `<a class="btn${primary}" href="${urls[target.os] ?? RELEASES}">${ICON}${target.label}${note}</a>`;
        if (!target.alt) return button;
        // The alternative package rides along as a small segment joined to the main button.
        const alt = `<a class="btn seg" href="${urls[target.alt.key] ?? RELEASES}" title="${target.alt.label}" aria-label="Download the ${target.alt.label}">${target.alt.short}</a>`;
        return `<span class="btn-group">${button}${alt}</span>`;
      })
      .join("");
    for (const slot of document.querySelectorAll("[data-downloads]")) slot.innerHTML = html;
    layout();
  }

  render({});
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((release) => {
      const urls = {};
      for (const target of TARGETS) {
        const asset = release.assets.find((item) => target.match.test(item.name));
        if (asset) urls[target.os] = asset.browser_download_url;
        const altAsset = target.alt && release.assets.find((item) => target.alt.match.test(item.name));
        if (altAsset) urls[target.alt.key] = altAsset.browser_download_url;
      }
      render(urls);
      for (const slot of document.querySelectorAll("[data-version]")) slot.textContent = release.tag_name;
    })
    .catch(() => {
      // Offline or rate-limited: the buttons already point at the releases page.
    });
})();
