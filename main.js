"use strict";

const { Plugin, PluginSettingTab, Setting } = require("obsidian");

const GRAPH_VIEW_TYPES = ["graph", "localgraph"];

// Multiplier applied to the target scale per zoom-button click.
const ZOOM_STEP = 1.2;

// Per-event zoom multiplier. A mouse wheel reports large deltas (≈100 per
// notch), while a trackpad pinch reports tiny ones (a few px), so a single
// constant makes the pinch feel sluggish. We pick the sensitivity by delta
// magnitude: small deltas (pinch / trackpad) get a much higher multiplier.
const ZOOM_WHEEL_SENSITIVITY = 0.0018; // large deltas (mouse wheel notch)
const ZOOM_PINCH_SENSITIVITY = 0.01;   // small deltas (trackpad pinch)
const FINE_ZOOM_DELTA = 40;            // |deltaY| below this counts as a fine gesture

const DEFAULT_SETTINGS = {
  panSpeed: 1.0,
  zoomSpeed: 1.0,
  zoomToCursor: true,
  shiftDragPan: true,
  invertX: false,
  invertY: false,
  showZoomButtons: true,
};

module.exports = class GraphScrollPanPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new GraphScrollPanSettingTab(this.app, this));

    // Shift + drag pans the graph (grabs the background, even over a node). The
    // move/up handlers live on the window so a drag keeps working if the pointer
    // leaves the view.
    this.registerDomEvent(window, "pointermove", (e) => this.onDragMove(e));
    this.registerDomEvent(window, "pointerup", () => this.endDrag());
    this.registerDomEvent(window, "pointercancel", () => this.endDrag());
    this.registerDomEvent(window, "blur", () => this.endDrag());

    // Patch graphs that are already open as well as any opened later.
    this.app.workspace.onLayoutReady(() => this.patchAllGraphLeaves());
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.patchAllGraphLeaves())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.patchAllGraphLeaves())
    );
  }

  patchAllGraphLeaves() {
    const leaves = [];
    for (const type of GRAPH_VIEW_TYPES) {
      leaves.push(...this.app.workspace.getLeavesOfType(type));
    }

    for (const leaf of leaves) {
      this.patchView(leaf.view);
    }
  }

  patchView(view) {
    if (!view || view._graphScrollPanPatched) {
      return;
    }

    const renderer = view.renderer;
    if (!renderer) {
      return;
    }

    // Attach to the canvas parent (containerEl) in the capture phase so we run
    // before the renderer's native onWheel handler on the canvas itself.
    const target = renderer.containerEl || view.containerEl;
    if (!target) {
      return;
    }

    const handler = (e) => this.onWheel(e, renderer);
    target.addEventListener("wheel", handler, { capture: true, passive: false });

    // Shift + drag → start a pan and stop the graph from grabbing a node.
    const onPointerDown = (e) => this.onDragStart(e, renderer);
    target.addEventListener("pointerdown", onPointerDown, { capture: true });

    // The graph's native drag (node move / pan) is mouse-event driven, so also
    // swallow a Shift+mousedown to keep it from running alongside our pan.
    const onMouseDown = (e) => {
      if (this.settings.shiftDragPan && e.shiftKey && (e.button == null || e.button === 0)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    target.addEventListener("mousedown", onMouseDown, { capture: true });

    view._graphScrollPanPatched = true;

    const cleanup = () => {
      target.removeEventListener("wheel", handler, { capture: true });
      target.removeEventListener("pointerdown", onPointerDown, { capture: true });
      target.removeEventListener("mousedown", onMouseDown, { capture: true });
      delete view._graphScrollPanPatched;
    };
    view._graphScrollPanCleanup = cleanup;
    this.register(cleanup);

    if (this.settings.showZoomButtons) {
      this.addZoomControls(target, renderer);
    }
  }

  onWheel(e, renderer) {
    if (!renderer.px) {
      return;
    }

    // Pinch gestures (macOS delivers them as ctrlKey wheel events) or
    // Cmd/Ctrl+scroll: drive the renderer's own zoom. Passing a center point
    // keeps that point fixed (zoom toward the cursor); omitting it zooms around
    // the view center.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();

      // Small deltas (trackpad pinch / two-finger gesture) need a higher
      // multiplier than a coarse mouse-wheel notch to feel responsive.
      const fine = Math.abs(e.deltaY) < FINE_ZOOM_DELTA;
      const sensitivity =
        (fine ? ZOOM_PINCH_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY) *
        this.settings.zoomSpeed;

      const factor = Math.exp(-e.deltaY * sensitivity);
      const targetScale = renderer.targetScale * factor;

      if (this.settings.zoomToCursor && e.currentTarget) {
        // Cursor position inside the canvas, in device pixels (the renderer's
        // coordinate space).
        const dpr = window.devicePixelRatio || 1;
        const rect = e.currentTarget.getBoundingClientRect();
        const center = {
          x: (e.clientX - rect.left) * dpr,
          y: (e.clientY - rect.top) * dpr,
        };
        renderer.zoomTo(targetScale, center);
      } else {
        renderer.zoomTo(targetScale);
      }

      renderer.changed();
      return;
    }

    // Plain scroll (two-finger swipe): pan instead, and block the native zoom.
    e.preventDefault();
    e.stopImmediatePropagation();

    const dpr = window.devicePixelRatio || 1;
    const speed = this.settings.panSpeed;
    const signX = this.settings.invertX ? -1 : 1;
    const signY = this.settings.invertY ? -1 : 1;

    const dx = e.deltaX * dpr * speed * signX;
    const dy = e.deltaY * dpr * speed * signY;

    renderer.setPan(renderer.panX - dx, renderer.panY - dy);
    renderer.changed();
  }

  // Hold Shift and drag to grab the background and pan it — the point under the
  // cursor follows the cursor. Works anywhere, even over a node.
  onDragStart(e, renderer) {
    if (!this.settings.shiftDragPan || !e.shiftKey) {
      return;
    }
    if (e.button != null && e.button !== 0) {
      return;
    }
    if (!renderer.px) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    // The renderer binds pointer/hover handling to interactiveEl (fall back to
    // the canvas) — that's where a synthetic move must be dispatched.
    const hoverEl = renderer.interactiveEl || (renderer.px && renderer.px.view);
    this._drag = { renderer, hoverEl, lastX: e.clientX, lastY: e.clientY };
  }

  onDragMove(e) {
    const drag = this._drag;
    if (!drag) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const dx = (e.clientX - drag.lastX) * dpr;
    const dy = (e.clientY - drag.lastY) * dpr;
    if (dx === 0 && dy === 0) {
      return;
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    const r = drag.renderer;
    // Move the content with the cursor so the grabbed point stays under it.
    r.setPan(r.panX + dx, r.panY + dy);
    r.changed();
  }

  endDrag() {
    const drag = this._drag;
    this._drag = null;
    if (!drag || !drag.hoverEl) {
      return;
    }
    // The renderer only recomputes node hover on pointer movement. After a drag
    // that ends on a node the pointer is stationary, so hover stays stale until
    // the cursor leaves and re-enters. Nudge it with a synthetic move at the
    // current cursor position, after the pan's render settles (rAF).
    const el = drag.hoverEl;
    const x = drag.lastX;
    const y = drag.lastY;
    requestAnimationFrame(() => {
      const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window };
      try {
        el.dispatchEvent(new PointerEvent("pointermove", { ...opts, pointerType: "mouse" }));
      } catch (e) {}
      el.dispatchEvent(new MouseEvent("mousemove", opts));
    });
  }

  addZoomControls(container, renderer) {
    const controls = document.createElement("div");
    controls.addClass("graph-scroll-pan-controls");

    const makeButton = (label, ariaLabel, factor) => {
      const btn = document.createElement("button");
      btn.addClass("graph-scroll-pan-zoom-button");
      btn.textContent = label;
      btn.setAttribute("aria-label", ariaLabel);
      // Stop the press from starting a graph drag underneath.
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.zoomBy(renderer, factor);
      });
      controls.appendChild(btn);
    };

    makeButton("+", "Zoom in", ZOOM_STEP);
    makeButton("−", "Zoom out", 1 / ZOOM_STEP);

    container.appendChild(controls);
    this.register(() => controls.remove());
  }

  zoomBy(renderer, factor) {
    if (!renderer.px) {
      return;
    }

    // Omitting the center makes the renderer zoom around the view center,
    // and updateZoom() animates the transition smoothly.
    renderer.zoomTo(renderer.targetScale * factor);
    renderer.changed();
  }
};

class GraphScrollPanSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Pan speed")
      .setDesc("Multiplier for how far the graph moves per scroll. (default 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.2, 3.0, 0.1)
          .setValue(this.plugin.settings.panSpeed)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.panSpeed = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Zoom speed")
      .setDesc("Multiplier for pinch and Cmd/Ctrl+scroll zoom. Raise it if pinch feels too slow. (default 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.2, 3.0, 0.1)
          .setValue(this.plugin.settings.zoomSpeed)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.zoomSpeed = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Zoom to cursor")
      .setDesc("Zoom toward the mouse pointer instead of the view center.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.zoomToCursor)
          .onChange(async (value) => {
            this.plugin.settings.zoomToCursor = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Shift-drag to pan")
      .setDesc("Hold Shift and drag to pan the graph from anywhere, without grabbing a node.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.shiftDragPan)
          .onChange(async (value) => {
            this.plugin.settings.shiftDragPan = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Invert horizontal")
      .setDesc("Flip the horizontal pan direction.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.invertX).onChange(async (value) => {
          this.plugin.settings.invertX = value;
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("Invert vertical")
      .setDesc("Flip the vertical pan direction.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.invertY).onChange(async (value) => {
          this.plugin.settings.invertY = value;
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("Show zoom buttons")
      .setDesc("Show + / − zoom buttons over the graph. Reopen the graph view to apply.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showZoomButtons)
          .onChange(async (value) => {
            this.plugin.settings.showZoomButtons = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
}
