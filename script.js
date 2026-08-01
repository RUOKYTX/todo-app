/* ========== 待办任务核心逻辑（Supabase Auth + 实时同步） ========== */

// 任务数组：每个任务为 { id, text, done }
let tasks = [];

// 当前登录用户（null = 未登录）
let currentUser = null;

// 实时订阅通道（登录时建立，登出时移除）
let tasksChannel = null;

/* ---------- Supabase 客户端 ---------- */

// Project URL 与 anon 公钥（publishable 公钥可安全暴露在前端）
const SUPABASE_URL = "https://wctszhnobkiasoksbool.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_bv7RoCVKh4TJZRyf9S0gCg_mKYzrkg0";

// 创建 Supabase 客户端（由 CDN 引入的全局 supabase 对象提供）
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- 页面元素引用 ---------- */
const authView = document.getElementById("auth-view");
const todoView = document.getElementById("todo-view");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const authSubmitBtn = document.getElementById("auth-submit-btn");
const authSwitchTip = document.getElementById("auth-switch-tip");
const authSwitchLink = document.getElementById("auth-switch-link");
const authError = document.getElementById("auth-error");
const logoutBtn = document.getElementById("logout-btn");
const form = document.getElementById("add-form");
const input = document.getElementById("task-input");
const list = document.getElementById("task-list");
const counter = document.getElementById("counter");
const emptyTip = document.getElementById("empty-tip");
const dateText = document.getElementById("date-text");

/* ---------- 视图切换（登录前 / 登录后） ---------- */

function showAuthView() {
  todoView.style.display = "none";
  authView.style.display = "block";
  authEmail.focus();
}

function showTodoView() {
  authView.style.display = "none";
  todoView.style.display = "block";
  // 登录后：拉取当前用户任务 + 建立实时订阅
  loadTasksForUser();
  input.focus();
}

/* ---------- 数据层：Supabase（按当前用户隔离） ---------- */

// 拉取当前用户的任务（RLS + 显式 user_id 双保险），按创建时间排序
async function fetchTasks() {
  if (!currentUser) return [];
  const { data, error } = await supabaseClient
    .from("todos")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at");
  if (error) {
    console.error("加载任务失败：", error.message);
    return [];
  }
  // 数据库字段 task/done → 前端字段 text/done，id 直接复用主键
  return data.map((row) => ({ id: row.id, text: row.task, done: row.done }));
}

// 登录后：拉任务 + 渲染 + 建立实时订阅
async function loadTasksForUser() {
  tasks = await fetchTasks();
  render();
  subscribeRealtime();
}

/* ---------- 实时同步（postgres_changes 订阅） ---------- */

// 订阅 todos 表的所有增删改事件：收到变化 → 自动重拉列表渲染
function subscribeRealtime() {
  // 幂等：若已有旧通道先移除，避免重复订阅
  if (tasksChannel) supabaseClient.removeChannel(tasksChannel);

  tasksChannel = supabaseClient
    .channel("todos-realtime")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "todos" },
      async () => {
        tasks = await fetchTasks();
        render();
      }
    )
    .subscribe();
}

// 登出时移除订阅
function unsubscribeRealtime() {
  if (tasksChannel) {
    supabaseClient.removeChannel(tasksChannel);
    tasksChannel = null;
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

// 添加任务：自动带上当前用户的 user_id
async function addTask(text) {
  const trimmed = text.trim();
  if (!trimmed || !currentUser) return; // 空输入或未登录时忽略

  // 插入新行：task 文字 + done=false + 当前用户 id，created_at 由数据库自动生成
  const { error } = await supabaseClient
    .from("todos")
    .insert({ task: trimmed, done: false, user_id: currentUser.id });
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

/* ---------- 认证逻辑（注册 / 登录 / 登出） ---------- */

// 当前模式：login（登录）或 signup（注册）
let authMode = "login";

// 切换登录/注册模式，同步界面文案
function setAuthMode(mode) {
  authMode = mode;
  authSubmitBtn.textContent = mode === "login" ? "登 录" : "注 册";
  authSwitchTip.textContent = mode === "login" ? "还没有账号？" : "已有账号？";
  authSwitchLink.textContent = mode === "login" ? "注册" : "登录";
  authError.textContent = "";
}

// 把 Supabase 报错翻译成友好中文提示
function friendlyAuthError(err) {
  const map = {
    "Invalid login credentials": "邮箱或密码错误",
    "Email not confirmed": "邮箱未验证，请先查收验证邮件",
    "User already registered": "该邮箱已注册，请直接登录",
    "Password should be at least 6 characters": "密码至少需要 6 位",
  };
  return map[err.message] || err.message;
}

// 登录/注册表单提交
authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;

  authError.textContent = ""; // 清空上一次错误
  if (!email || password.length < 6) {
    authError.textContent = "请输入邮箱和至少 6 位密码";
    return;
  }

  authSubmitBtn.disabled = true; // 防重复提交
  let result;
  if (authMode === "login") {
    result = await supabaseClient.auth.signInWithPassword({ email, password });
  } else {
    result = await supabaseClient.auth.signUp({ email, password });
  }
  authSubmitBtn.disabled = false;

  if (result.error) {
    authError.textContent = friendlyAuthError(result.error);
    return;
  }

  // 注册成功但没拿到 session（邮箱验证未关闭时的兜底提示）
  if (authMode === "signup" && !result.data.session) {
    authError.textContent = "注册成功！请查收验证邮件后登录";
    setAuthMode("login");
    return;
  }
  // 拿到 session 时，onAuthStateChange 会自动切换视图，无需手动处理
});

// 点击"注册/登录"链接切换模式
authSwitchLink.addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(authMode === "login" ? "signup" : "login");
});

// 退出登录
logoutBtn.addEventListener("click", () => {
  supabaseClient.auth.signOut();
});

/* ---------- 登录状态监听 ---------- */

// 监听登录态变化：登录 → 切任务视图；登出 → 清理并回登录界面
supabaseClient.auth.onAuthStateChange((event, session) => {
  currentUser = session?.user ?? null;

  if (event === "SIGNED_IN") {
    showTodoView();
  } else if (event === "SIGNED_OUT") {
    unsubscribeRealtime();
    tasks = [];
    render();
    showAuthView();
  }
});

/* ---------- 任务事件绑定 ---------- */

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

// 页面加载：恢复登录态 → 决定显示哪个视图（刷新后自动保持登录）
async function init() {
  showToday();

  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user ?? null;
  if (currentUser) {
    showTodoView();
  } else {
    showAuthView();
  }
}
init();
