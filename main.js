"use strict";

const { Plugin, PluginSettingTab, Setting } = require("obsidian");

const GRAPH_VIEW_TYPES = ["graph", "localgraph"];

// Multiplier applied to the target scale per zoom-button click.
const ZOOM_STEP = 1.2;

// Per-event zoom multiplier for Cmd/Ctrl+scroll and pinch. Tuned so a typical
// mouse-wheel notch (deltaY ≈ 100) lands close to one ZOOM_STEP, while a
// trackpad pinch (small deltaY) stays smooth.
const ZOOM_WHEEL_SENSITIVITY = 0.0018;

const DEFAULT_SETTINGS = {
  panSpeed: 1.0,
  invertX: false,
  invertY: false,
  showZoomButtons: true,
};

module.exports = class GraphScrollPanPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new GraphScrollPanSettingTab(this.app, this));

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

    view._graphScrollPanPatched = true;

    const cleanup = () => {
      target.removeEventListener("wheel", handler, { capture: true });
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
    // Cmd/Ctrl+scroll: zoom around the view center instead of deferring to the
    // native cursor-anchored zoom, which drifts the graph when the cursor is
    // off-center. This keeps zooming consistent with the + / − buttons.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();

      const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY);
      renderer.zoomTo(renderer.targetScale * factor);
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
