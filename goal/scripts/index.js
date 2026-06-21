// goal/scripts/index.js
// goal 增强注册模块 — 独立 skill，不 patch 任何 OpenSpec 文件。
// os-stronger init 选中 goal 时，只创建 skill 文件到各工具目录。

const path = require('path');

// goal/ 目录的绝对路径（scripts/ 的上一级）
const GOAL_DIR = path.resolve(__dirname, '..');

module.exports = {
  id: 'goal',
  label: 'goal — 长程目标编排（多 change 交替 propose→apply + test→fix 循环）',

  // goal 不 patch 任何文件
  patches: {},

  // 不需要额外支撑文件（goal 文件夹在运行时由 CLI 创建）
  files: [],

  // skill 模板（在 goal/ 根目录）
  skillTemplate: 'skill.md',
  skillTemplateDir: GOAL_DIR,
};
