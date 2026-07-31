/* ========== 待办任务核心逻辑 ========== */

// 任务数组：每个任务为 { id, text, done }
let tasks = [];

/* ---------- Supabase 连接（替代 localStorage 存储） ---------- */

// Project URL 与 anon 公钥（publishable 公钥可安全暴露在前端）
const SUPABASE_URL = "https://wctszhnobkiasoksbool.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_bv7RoCVKh4TJZRyf9S0gCg_mKYzrkg0";

// 创建 Supabase 客户端（由 CDN 引入的全局 supabase 对象提供）
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 从 Supabase 拉取全部任务，按创建时间排序；数据库行 → 前端对象映射
async function fetchTasks() {
  const { data, error } = await supabaseClient
    .from("todos")
    .select("*")
    .order("created_at");
  if (error) {
    console.error("加载任务失败：", error.message);
    return [];
  }
  // 数据库字段 task/done → 前端字段 text/done，id 直接复用主键
  return data.map((row) => ({ id: row.id, text: row.task, done: row.done }));
}

/* ---------- 页面元素引用 ---------- */
const form = document.getElementById("add-form");
const input = document.getElementById("task-input");
const list = document.getElementById("task-list");
const counter = document.getElementById("counter");
const emptyTip = document.getElementById("empty-tip");
const dateText = document.getElementById("date-text");

/* ---------- 渲染 ---------- */

// 根据 tasks 数组重绘整个列表
function render() {
  list.innerHTML = "";

  tasks.forEach((task) => {
    // 创建任务项 <li>
    const item = document.createElement("li");
    item.className = "task-item" + (task.done ? " done" : "");
    item.dataset.id = task.id;

    // 圆形勾选框（点击切换完成状态）
    const box = document.createElement("span");
    box.className = "checkbox";
    box.textContent = "✓";

    // 任务文字（双击进入编辑）
    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = task.text;

    // 删除按钮
    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "✕";
    del.setAttribute("aria-label", "删除任务");

    item.append(box, text, del);
    list.appendChild(item);
  });

  // 更新统计行（统一由 updateUnfinishedCount 输出）与空状态提示
  updateUnfinishedCount();
  emptyTip.style.display = tasks.length ? "none" : "block";
}

/* ---------- 事件处理 ---------- */

// 添加任务
async function addTask(text) {
  const trimmed = text.trim();
  if (!trimmed) return; // 空输入忽略

  // 插入新行：task 文字 + done=false，created_at 由数据库自动生成
  const { error } = await supabaseClient
    .from("todos")
    .insert({ task: trimmed, done: false });
  if (error) {
    console.error("添加任务失败：", error.message);
    return;
  }

  tasks = await fetchTasks(); // 重新拉取，保证与数据库一致
  render();
  updateUnfinishedCount(); // 添加后未完成数量 +1
}

// 更新统计信息：已完成/未完成合并显示在一行；无任务时不显示
function updateUnfinishedCount() {
  const total = tasks.length;
  if (!total) {
    counter.textContent = ""; // 无任务时不显示统计行
    return;
  }
  const doneCount = tasks.filter((t) => t.done).length;
  counter.textContent = `共 ${total} 项，已完成 ${doneCount} 项，未完成 ${total - doneCount} 项`;
}

// 切换任务的完成状态
async function toggleTask(id) {
  // id 统一转字符串比较（数据库 id 可能是数字或 uuid）
  const task = tasks.find((t) => String(t.id) === id);
  if (!task) return;

  // 按主键 id 更新 done 字段
  const { error } = await supabaseClient
    .from("todos")
    .update({ done: !task.done })
    .eq("id", id);
  if (error) {
    console.error("更新完成状态失败：", error.message);
    return;
  }

  tasks = await fetchTasks();
  render();
  updateUnfinishedCount(); // 勾选后未完成数量 -1，取消勾选 +1
}

// 修改任务的文字内容
async function updateTask(id, newText) {
  // 按主键 id 更新 task 字段
  const { error } = await supabaseClient
    .from("todos")
    .update({ task: newText })
    .eq("id", id);
  if (error) {
    console.error("修改任务失败：", error.message);
    return;
  }

  tasks = await fetchTasks();
  render();
}

// 删除任务
async function deleteTask(id) {
  // 按主键 id 删除行
  const { error } = await supabaseClient
    .from("todos")
    .delete()
    .eq("id", id);
  if (error) {
    console.error("删除任务失败：", error.message);
    return;
  }

  tasks = await fetchTasks();
  render();
  updateUnfinishedCount(); // 删除未完成任务后数量 -1
}

/* ---------- 编辑任务文字（双击进入编辑） ---------- */

// 把任务文字替换为输入框进行编辑
function startEdit(item, textEl) {
  const id = item.dataset.id;
  const task = tasks.find((t) => String(t.id) === id);
  if (!task) return;

  // 创建编辑输入框，预填原文字
  const editInput = document.createElement("input");
  editInput.className = "edit-input";
  editInput.value = task.text;
  editInput.maxLength = 100;
  textEl.replaceWith(editInput);
  editInput.focus();
  editInput.select(); // 全选文字，方便直接覆盖输入

  // finished 标志防止 回车+失焦 导致重复保存/渲染
  let finished = false;

  function finish(save) {
    if (finished) return;
    finished = true;

    const newText = editInput.value.trim();
    // 保存时：内容非空且发生变化才写入数据库
    if (save && newText && newText !== task.text) {
      updateTask(task.id, newText); // 异步写入 Supabase，完成后自动刷新渲染
      return;
    }
    render(); // 取消或内容未变：直接恢复原列表
  }

  // 回车 → 保存；Esc → 取消
  editInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });

  // 点击别处失焦 → 保存
  editInput.addEventListener("blur", () => finish(true));
}

/* ---------- 事件绑定 ---------- */

// 表单提交（输入框回车 或 点＋按钮）→ 添加任务
form.addEventListener("submit", (e) => {
  e.preventDefault();
  addTask(input.value);
  input.value = ""; // 清空输入框
  input.focus(); // 保持焦点方便连续录入
});

// 双击任务文字 → 进入编辑模式（改为行内输入框）
list.addEventListener("dblclick", (e) => {
  const textEl = e.target.closest(".task-text");
  if (!textEl) return;
  const item = textEl.closest(".task-item");
  if (item.classList.contains("done")) return; // 已完成的任务不允许编辑
  startEdit(item, textEl);
});

// 事件委托：列表内的点击统一处理（勾选 / 删除）
// 注意：点击圆圈才勾选，文字留给双击编辑（避免单击重建 DOM 吃掉双击事件）
list.addEventListener("click", (e) => {
  const item = e.target.closest(".task-item");
  if (!item) return;
  const id = item.dataset.id;

  if (e.target.classList.contains("delete-btn")) {
    deleteTask(id);
  } else if (e.target.classList.contains("checkbox")) {
    toggleTask(id);
  }
});

/* ---------- 初始化 ---------- */

// 显示当天日期（如 2026年7月31日 星期五）
function showToday() {
  const now = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"];
  dateText.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week[now.getDay()]}`;
}

// 页面加载：从 Supabase 拉取任务 → 渲染列表 → 显示日期 → 显示未完成数量
async function init() {
  tasks = await fetchTasks();
  render();
  showToday();
  updateUnfinishedCount(); // 从云端数据恢复数量
  input.focus();
}
init();
