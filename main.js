"use strict";

const { Plugin, PluginSettingTab, Setting } = require("obsidian");

const GRAPH_VIEW_TYPES = ["graph", "localgraph"];

const DEFAULT_SETTINGS = {
  panSpeed: 1.0,
  invertX: false,
  invertY: false,
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
  }

  onWheel(e, renderer) {
    // Pinch gestures (macOS delivers them as ctrlKey wheel events) or
    // Cmd/Ctrl+scroll: defer to the native zoom behavior.
    if (e.ctrlKey || e.metaKey) {
      return;
    }

    // Plain scroll (two-finger swipe): pan instead, and block the native zoom.
    e.preventDefault();
    e.stopImmediatePropagation();

    if (!renderer.px) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const speed = this.settings.panSpeed;
    const signX = this.settings.invertX ? -1 : 1;
    const signY = this.settings.invertY ? -1 : 1;

    const dx = e.deltaX * dpr * speed * signX;
    const dy = e.deltaY * dpr * speed * signY;

    renderer.setPan(renderer.panX - dx, renderer.panY - dy);
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
  }
}
