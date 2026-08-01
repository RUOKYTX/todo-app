/* ========== 待办任务核心逻辑（Supabase Auth + 实时同步） ========== */

// 任务数组：每个任务为 { id, text, done }
let tasks = [];

// 当前登录用户（null = 未登录）
let currentUser = null;

// 实时订阅通道（登录时建立，登出时移除）
let tasksChannel = null;

// 本页最近操作影响的数据库行 id：订阅回调据此跳过自己的事件，避免双重刷新
const recentIds = new Set();

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
const form = document.getElementById("add-form");
const input = document.getElementById("task-input");
const list = document.getElementById("task-list");
const counter = document.getElementById("counter");
const emptyTip = document.getElementById("empty-tip");
const dateText = document.getElementById("date-text");
const avatarBtn = document.getElementById("avatar-btn");
const avatarMenu = document.getElementById("avatar-menu");
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalDesc = document.getElementById("modal-desc");
const modalBody = document.getElementById("modal-body");
const modalCancel = document.getElementById("modal-cancel");
const modalConfirm = document.getElementById("modal-confirm");
const toast = document.getElementById("toast");

/* ---------- 视图切换（登录前 / 登录后） ---------- */

function showAuthView() {
  todoView.style.display = "none";
  authView.style.display = "block";
  authEmail.focus();
}

function showTodoView() {
  authView.style.display = "none";
  todoView.style.display = "block";
  renderAvatar(); // 登录后渲染首字头像
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
    return null; // 返回 null 表示拉取失败（调用方据此保留现状，避免误清列表）
  }
  // 数据库字段 task/done → 前端字段 text/done，id 直接复用主键
  return data.map((row) => ({ id: row.id, text: row.task, done: row.done }));
}

// 登录后：拉任务 + 渲染 + 建立实时订阅
async function loadTasksForUser() {
  const fresh = await fetchTasks();
  if (fresh !== null) tasks = fresh; // 初始加载失败则保持空列表（空状态提示兜底）
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
      async (payload) => {
        // 取事件涉及的行 id（insert/update 看 new，delete 看 old）
        const eventId = payload.new?.id ?? payload.old?.id;
        // 自己发起的操作（id 在 recentIds 中）→ 跳过，避免双重刷新
        if (eventId !== undefined && recentIds.has(eventId)) {
          recentIds.delete(eventId);
          return;
        }
        const fresh = await fetchTasks();
        if (fresh !== null) {
          tasks = fresh;
          render();
        }
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
  // 记录重建前的任务 id 集合：只给"新添加"的任务播放淡入动画
  const prevIds = new Set([...list.children].map((li) => li.dataset.id));

  list.innerHTML = "";

  tasks.forEach((task) => {
    // 创建任务项 <li>（新任务带 new-item 类触发淡入，其余不重播动画避免闪烁）
    const item = document.createElement("li");
    const isNew = !prevIds.has(String(task.id));
    item.className = "task-item" + (task.done ? " done" : "") + (isNew ? " new-item" : "");
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

// 临时 id 自增器（负数，不与数据库正 id 冲突）：乐观插入时占位用
let tempIdCounter = 0;

// 添加任务：乐观更新（本地立即显示，后台写库，成功后静默替换真实 id）
async function addTask(text) {
  const trimmed = text.trim();
  if (!trimmed || !currentUser) return; // 空输入或未登录时忽略

  // ① 乐观：本地用临时负 id 插入并立即渲染（任务瞬间出现）
  const tempId = --tempIdCounter;
  tasks.push({ id: tempId, text: trimmed, done: false });
  render();
  updateUnfinishedCount();

  // ② 后台插入（.select() 拿数据库生成的真实 id）
  const { data, error } = await supabaseClient
    .from("todos")
    .insert({ task: trimmed, done: false, user_id: currentUser.id })
    .select();
  if (error) {
    // 失败：移除自己的临时行 + 尽力对齐（对齐失败时保留本地回滚后的列表）
    console.error("添加任务失败：", error.message);
    tasks = tasks.filter((t) => t.id !== tempId);
    const fresh = await fetchTasks();
    if (fresh !== null) {
      tasks = fresh;
      render();
      updateUnfinishedCount();
      return;
    }
    render();
    updateUnfinishedCount();
    return;
  }

  // ③ 成功：真实 id 静默替换（只改数组项与对应 li 的 dataset.id，不整表重渲染）
  const realId = data[0].id;
  recentIds.add(realId); // 跳过 insert 事件，避免重复刷新
  const idx = tasks.findIndex((t) => t.id === tempId);
  if (idx !== -1) {
    tasks[idx].id = realId;
    const li = list.querySelector(`li[data-id="${tempId}"]`);
    if (li) li.dataset.id = realId;
  }
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

// 切换任务的完成状态（乐观更新：立即本地渲染，后台写库）
async function toggleTask(id) {
  const task = tasks.find((t) => String(t.id) === id);
  if (!task) return;

  // ① 乐观更新：本地立即翻转并渲染，不等网络（消除勾选响应缓慢）
  task.done = !task.done;
  recentIds.add(Number(id)); // 防止自己的写入事件触发重复刷新（与事件 id 同为数字）
  render();
  updateUnfinishedCount();

  // ② 后台写库（不 select、不 fetchTasks：本地已是最终状态）
  const { error } = await supabaseClient
    .from("todos")
    .update({ done: task.done })
    .eq("id", id);
  if (error) {
    // ③ 失败：回滚本次翻转 + 尽力对齐（对齐失败时保留回滚后的本地状态）
    console.error("更新完成状态失败：", error.message);
    recentIds.delete(Number(id));
    task.done = !task.done;
    const fresh = await fetchTasks();
    if (fresh !== null) {
      tasks = fresh;
      render();
      updateUnfinishedCount();
      return;
    }
    render();
    updateUnfinishedCount();
    return;
  }
}

// 修改任务的文字内容（乐观更新：本地立即生效，后台写库，失败回滚对齐）
async function updateTask(id, newText, oldText) {
  const task = tasks.find((t) => String(t.id) === String(id));
  if (!task) return;

  // ① 乐观：本地立即更新并渲染（编辑框即时退出，文字立即变化）
  task.text = newText;
  render();
  recentIds.add(Number(id)); // 跳过 update 事件，避免重复刷新

  // ② 后台写库（不 select、不 fetchTasks：本地已是最终状态）
  const { error } = await supabaseClient
    .from("todos")
    .update({ task: newText })
    .eq("id", id);
  if (error) {
    // ③ 失败：回滚文字 + 尽力对齐（对齐失败时保留回滚后的本地状态）
    console.error("修改任务失败：", error.message);
    recentIds.delete(Number(id));
    task.text = oldText;
    const fresh = await fetchTasks();
    if (fresh !== null) {
      tasks = fresh;
      render();
      return;
    }
    render();
  }
}

// 删除任务：乐观更新（本地立即移除，后台删除，失败恢复对齐）
async function deleteTask(id) {
  const target = tasks.find((t) => String(t.id) === id);
  if (!target) return;

  // ① 乐观：本地立即移除并渲染（任务瞬间消失）
  tasks = tasks.filter((t) => String(t.id) !== id);
  render();
  updateUnfinishedCount();
  recentIds.add(Number(id)); // 跳过 delete 事件，避免重复刷新

  // ② 后台删除
  const { error } = await supabaseClient
    .from("todos")
    .delete()
    .eq("id", id);
  if (error) {
    // ③ 失败：恢复被删任务 + 尽力对齐（对齐失败时保留回滚后的本地列表）
    console.error("删除任务失败：", error.message);
    recentIds.delete(Number(id));
    tasks.push(target);
    const fresh = await fetchTasks();
    if (fresh !== null) {
      tasks = fresh;
      render();
      updateUnfinishedCount();
      return;
    }
    render();
    updateUnfinishedCount();
  }
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
    // 保存时：内容非空且发生变化 → 乐观更新（本地立即生效 + 后台写库）
    if (save && newText && newText !== task.text) {
      updateTask(task.id, newText, task.text);
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

/* ---------- 个人信息（头像 / 密码 / 切换 / 注销） ---------- */

// 当前个人信息操作模式：avatar | password | switch | delete
let accountAction = null;

// toast 定时器（防止连续提示重叠）
let toastTimer = null;

// 渲染头像：优先取 user_metadata.avatar_char，否则取邮箱首字符大写
function renderAvatar() {
  if (!currentUser) return;
  const custom = currentUser.user_metadata?.avatar_char;
  const char = (custom || currentUser.email || "?").trim().charAt(0).toUpperCase();
  avatarBtn.textContent = char;
  // 把账户邮箱写入包裹层 data 属性，供悬浮气泡（CSS attr）显示
  avatarBtn.parentElement.dataset.username = currentUser.email || "?";
}

// 轻量提示（2.5 秒自动消失）
function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = "none";
  }, 2500);
}

// 点击头像：展开/收起个人信息菜单
avatarBtn.addEventListener("click", (e) => {
  e.stopPropagation(); // 防止冒泡触发下方 document 关闭监听
  avatarMenu.classList.toggle("open");
});

// 点击页面其他区域 → 关闭菜单
document.addEventListener("click", (e) => {
  if (!e.target.closest(".avatar-wrap")) {
    avatarMenu.classList.remove("open");
  }
});

// 菜单项点击 → 打开对应功能弹窗（退出登录例外：直接登出，无需弹窗）
avatarMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".menu-item");
  if (!item) return;
  avatarMenu.classList.remove("open");

  const action = item.dataset.action;
  if (action === "logout") {
    supabaseClient.auth.signOut(); // 退出登录：直接登出回登录界面
    return;
  }
  openAccountModal(action);
});

// 打开弹窗并按功能组装内容
function openAccountModal(action) {
  accountAction = action;
  modalBody.innerHTML = ""; // 清空动态内容
  modalConfirm.classList.remove("danger");

  if (action === "avatar") {
    modalTitle.textContent = "修改头像";
    modalDesc.textContent = "输入一个字作为头像展示（留空则恢复默认邮箱首字母）";
    const input = document.createElement("input");
    input.className = "modal-input";
    input.maxLength = 1;
    input.placeholder = "输入一个字";
    modalBody.appendChild(input);
    modalConfirm.textContent = "保存";
  } else if (action === "password") {
    modalTitle.textContent = "修改密码";
    modalDesc.textContent = "输入新密码（至少 6 位），下次登录请使用新密码";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "modal-input";
    input.minLength = 6;
    input.placeholder = "新密码";
    modalBody.appendChild(input);
    modalConfirm.textContent = "确认修改";
  } else if (action === "switch") {
    modalTitle.textContent = "切换账号";
    modalDesc.textContent = "将退出当前账号并返回登录界面，可切换其他账号登录，确认吗？";
    modalConfirm.textContent = "切换";
  } else if (action === "delete") {
    modalTitle.textContent = "注销账号";
    modalDesc.textContent = "注销后该账号及其所有任务将被永久删除且无法恢复，确定吗？";
    modalConfirm.textContent = "确认注销";
    modalConfirm.classList.add("danger"); // 危险操作红色按钮
  }

  modalOverlay.style.display = "flex";
  // 弹窗打开后聚焦输入框
  const firstInput = modalBody.querySelector("input");
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

// 关闭弹窗
function closeAccountModal() {
  modalOverlay.style.display = "none";
  accountAction = null;
  modalConfirm.classList.remove("danger");
}

modalCancel.addEventListener("click", closeAccountModal);

// 点击遮罩空白区域 → 关闭弹窗
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeAccountModal();
});

// 弹窗确认按钮：按模式执行对应操作
modalConfirm.addEventListener("click", async () => {
  if (accountAction === "avatar") {
    // 修改头像：写进 user_metadata（刷新后仍生效）
    const input = modalBody.querySelector("input");
    const char = (input?.value || "").trim();
    const { error } = await supabaseClient.auth.updateUser({
      data: { avatar_char: char },
    });
    if (error) {
      showToast("修改失败：" + error.message);
      return;
    }
    currentUser = (await supabaseClient.auth.getSession()).data.session?.user;
    renderAvatar();
    showToast("头像已更新");
    closeAccountModal();
  } else if (accountAction === "password") {
    // 修改密码
    const input = modalBody.querySelector("input");
    const pwd = input?.value || "";
    if (pwd.length < 6) return; // 前端最小长度校验
    const { error } = await supabaseClient.auth.updateUser({ password: pwd });
    if (error) {
      showToast("修改失败：" + friendlyAuthError(error));
      return;
    }
    showToast("密码已修改");
    closeAccountModal();
  } else if (accountAction === "switch") {
    // 切换账号：登出回登录界面
    closeAccountModal();
    supabaseClient.auth.signOut();
  } else if (accountAction === "delete") {
    // 注销账号：调用 SECURITY DEFINER 函数，删除账号及其全部任务
    const { error } = await supabaseClient.rpc("delete_user");
    if (error) {
      showToast("注销失败：" + error.message);
      return;
    }
    closeAccountModal();
    showToast("账号已注销");
    supabaseClient.auth.signOut();
  }
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
  // 双击的第二击（e.detail=2）忽略：避免"勾选→取消"来回抖动
  if (e.detail > 1) return;

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
