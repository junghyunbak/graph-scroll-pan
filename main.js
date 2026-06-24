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

    // 이미 떠 있는 그래프 + 이후 새로 열리는 그래프 모두 패치
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

    // 캔버스의 부모(containerEl)에 capture 단계로 붙여 네이티브 onWheel 보다 먼저 가로챈다.
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
    // 핀치 제스처(macOS는 ctrlKey 붙은 wheel로 들어옴) 또는 Cmd/Ctrl+스크롤 → 네이티브 줌에 위임
    if (e.ctrlKey || e.metaKey) {
      return;
    }

    // 일반 스크롤(두 손가락 스와이프) → 이동으로 처리하고 네이티브 줌 차단
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
      .setName("이동 속도")
      .setDesc("스크롤 시 그래프가 움직이는 배율입니다. (기본 1.0)")
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
      .setName("가로 방향 반전")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.invertX).onChange(async (value) => {
          this.plugin.settings.invertX = value;
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("세로 방향 반전")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.invertY).onChange(async (value) => {
          this.plugin.settings.invertY = value;
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }
}
