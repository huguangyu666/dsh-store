/**
 * dsh-store client 端：侧边栏「插件商店」入口按钮 + 设置页「插件商店」分区。
 * 点击在 dsh 内打开完整商店（host 的 /plugin-store 页面）。
 * 入口组件复用 dsh 设计系统变量（--dsw-*），明暗自适应。
 */
const React = require("react");

/** 侧边栏入口按钮：点击打开商店页面 */
function StoreButton() {
  return React.createElement("button", {
    title: "dsh 插件商店（npm + awesome 精选目录，一键安装）",
    style: {
      display: "flex", alignItems: "center", gap: "6px", width: "100%",
      background: "transparent", border: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)",
      cursor: "pointer", padding: "6px 10px", borderRadius: "6px", fontSize: "12.5px",
      fontFamily: "var(--dsw-font-family, inherit)",
    },
    onClick: () => { window.open("/plugin-store", "_blank"); },
  },
    React.createElement("span", { style: { fontSize: "14px" } }, "🛒"),
    "插件商店");
}

/** 设置页分区：简洁入口 + 说明 */
function StoreSettingsSection() {
  const dim = "var(--dsw-alias-label-secondary)";
  const text = "var(--dsw-alias-label-primary)";
  const btn = "var(--dsw-alias-button-info-fill)";
  return React.createElement("div", { style: { padding: "8px 0", fontSize: "13px" } },
    React.createElement("p", { style: { color: dim, margin: "0 0 10px" } },
      "聚合 npm registry + awesome 精选 + 自动雷达的插件目录（550+ 插件、分类、星标、运行级验证），一键安装 / 卸载。"),
    React.createElement("button", {
      style: {
        background: btn, border: "none", color: "var(--dsw-alias-label-inverse, #fff)", borderRadius: "8px",
        padding: "8px 20px", fontSize: "13px", cursor: "pointer",
        fontFamily: "var(--dsw-font-family, inherit)",
      },
      onClick: () => { window.open("/plugin-store", "_blank"); },
    }, "打开插件商店"));
}

const name = "dsh-store";
const inject = ["slots"];

function apply(ctx) {
  ctx.effect(() => {
    const disposers = [];
    disposers.push(ctx.slots.register(
      { name: "sidebar.footer.action", id: "dsh-store", order: 5, label: "插件商店" },
      StoreButton));
    disposers.push(ctx.slots.register(
      { name: "settings.section", id: "dsh-store", order: 110, label: "插件商店" },
      StoreSettingsSection));
    return () => disposers.forEach((d) => d());
  });
}

module.exports = { name, inject, apply };
