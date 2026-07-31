/* ========== 待办任务核心逻辑 ========== */

// localStorage 的存储键名
const STORAGE_KEY = "todo-app-tasks";

// 任务数组：每个任务为 { id, text, done }
let tasks = [];

/* ---------- 页面元素引用 ---------- */
const form = document.getElementById("add-form");
const input = document.getElementById("task-input");
const list = document.getElementById("task-list");
const counter = document.getElementById("counter");
const emptyTip = document.getElementById("empty-tip");
const dateText = document.getElementById("date-text");

/* ---------- 数据存取：localStorage 持久化 ---------- */

// 保存任务到浏览器本地（刷新不丢的关键）
function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

// 从浏览器本地读取任务；首次访问则返回空数组
function loadTasks() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    // 数据损坏时清掉坏数据，避免页面崩溃
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

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

    // 任务文字（点击同样可切换状态）
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

  // 更新统计与空状态提示
  const doneCount = tasks.filter((t) => t.done).length;
  counter.textContent = tasks.length
    ? `共 ${tasks.length} 项，已完成 ${doneCount} 项`
    : "";
  emptyTip.style.display = tasks.length ? "none" : "block";
}

/* ---------- 事件处理 ---------- */

// 添加任务
function addTask(text) {
  const trimmed = text.trim();
  if (!trimmed) return; // 空输入忽略

  tasks.push({ id: Date.now(), text: trimmed, done: false });
  saveTasks();
  render();
}

// 切换任务的完成状态
function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.done = !task.done;
  saveTasks();
  render();
}

// 修改任务的文字内容
function updateTask(id, newText) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.text = newText;
  saveTasks();
  render();
}

// 删除任务
function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  saveTasks();
  render();
}

/* ---------- 编辑任务文字（双击进入编辑） ---------- */

// 把任务文字替换为输入框进行编辑
function startEdit(item, textEl) {
  const id = Number(item.dataset.id);
  const task = tasks.find((t) => t.id === id);
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
    // 保存时：内容非空才更新，且内容有变化才渲染
    if (save && newText && newText !== task.text) {
      task.text = newText;
      saveTasks();
    }
    render();
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
  const id = Number(item.dataset.id);

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

// 页面加载：读取本地数据 → 渲染列表 → 显示日期
tasks = loadTasks();
render();
showToday();
input.focus();
