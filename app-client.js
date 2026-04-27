  // @ts-nocheck
  'use strict';

  const getDeviceId = () => {
    let deviceId = localStorage.getItem('radar-device-id');
    if (!deviceId) {
      deviceId = 'dev-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('radar-device-id', deviceId);
    }
    return deviceId;
  };

  const App = {
    apiUrl: 'https://script.google.com/macros/s/AKfycbzRIBFJciZMM27Og_IeM5n5qcBfJhyp1whyjYrfeA7rxmoiLd8xUoFiuTzKG6NvZBDkVg/exec',
    deviceId: getDeviceId(),
    tasks: [],
    collaborators: [],
    departments: [],
    users: [],
    filteredTasks: [],
    currentView: 'kanban',
    filters: { statuses: [], teams: [], urgencies: [], responsibles: [], legacyOnly: false, search: '' },
    currentTask: null,
    currentDepartment: null,
    currentCollaborator: null,
    currentAccessUser: null,
    drawerMode: 'task',
    theme: 'dark',
    authMode: 'login',
    authPasswordVisible: false,
    authLoading: false,
    sessionToken: '',
    currentUser: null,
    draggedId: null,
    pendingComment: null,
    sidebarCollapsed: false,
    indicatorFocus: '',
    drawerTab: 'overview',
    bootstrappedFromCache: false,
    autoRefreshTimer: null,
    autoRefreshInFlight: false,
    lastBootstrapSignature: '',
    confirmResolver: null,
  };
  const ROLE_RANK = { visitante: 1, analista: 2, administrador: 3, dev: 4 };
  const CACHE_KEY = 'radar-bootstrap-cache-v2';
  const CACHE_TTL = 1000 * 60 * 30;
  const renderIcons = () => window.lucide?.createIcons?.();

  const COLUMNS = [
    { id: 'Não iniciado', label: 'Não Iniciado', color: 'var(--blue)', dot: '#4FC3F7' },
    { id: 'Em andamento', label: 'Em Andamento', color: 'var(--yellow)', dot: '#FFB347' },
    { id: 'Em pausa', label: 'Em Pausa', color: 'var(--purple)', dot: '#CE93D8' },
    { id: 'Finalizado', label: 'Finalizado', color: 'var(--green)', dot: '#4FFFB0' },
  ];

  const VIEW_META = {
    kanban: { title: 'Smart Kanban', action: '+ Nova Tarefa', sectionActions: true },
    list: { title: 'Lista de Tarefas', action: '+ Nova Tarefa', sectionActions: true },
    collaborators: { title: 'Colaboradores', action: '+ Novo Colaborador', sectionActions: false },
    departments: { title: 'Departamentos', action: '+ Novo Departamento', sectionActions: false },
    access: { title: 'Acessos', action: '+ Novo Usuário', sectionActions: false },
    sla: { title: 'SLA', action: '+ Novo Departamento', sectionActions: false },
    indicators: { title: 'Indicadores', action: '', sectionActions: false },
  };

  const parseLocalDate = (value) => {
    if (!value) return null;
    const raw = String(value).trim();
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      const [, year, month, day] = isoMatch;
      return new Date(Number(year), Number(month) - 1, Number(day));
    }
    const parsed = new Date(raw);
    return isNaN(parsed.getTime()) ? null : parsed;
  };

  const normalizeTaskStatus = (status) => {
    const raw = String(status || '').trim();
    const normalized = raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (normalized.startsWith('finalizado')) return 'Finalizado';
    if (normalized === 'em andamento') return 'Em andamento';
    if (normalized === 'em pausa') return 'Em pausa';
    return 'Não iniciado';
  };

  const isFinishedStatus = (status) => normalizeTaskStatus(status) === 'Finalizado';

  const getFinishedStatusLabel = (task) => {
    const status = String(task?.status || '').trim();
    if (status === 'Finalizado no prazo' || status === 'Finalizado em atraso') return status;
    return 'Finalizado';
  };

  const getUrgency = (task) => {
    const status = normalizeTaskStatus(task.status);
    if (status === 'Finalizado') return 'concluido';
    if (status === 'Em pausa') return 'pausado';
    if (!task.prazo_conclusao) return 'futuro';
    
    const today = new Date(); 
    today.setHours(0, 0, 0, 0);
    const prazo = parseLocalDate(task.prazo_conclusao);
    if (!prazo) return 'futuro';
    prazo.setHours(0, 0, 0, 0);

    if (prazo < today) return 'atrasado';
    if (prazo.getTime() === today.getTime()) return 'hoje';
    return 'futuro';
  };

  const urgencyLabel = (u) => ({ atrasado:'Atrasado', hoje:'Vence hoje', futuro:'No prazo', concluido:'Concluido', pausado:'Pausado' }[u] || '');

  const parseJsonSafe = (raw) => {
    try { return JSON.parse(raw || '[]'); } catch { return []; }
  };

  const progressInfo = (task) => {
    const subs = parseJsonSafe(task.subtarefas);
    if (!subs.length) return null;
    const done = subs.filter(s => s.concluido).length;
    return { done, total: subs.length, pct: Math.round((done / subs.length) * 100) };
  };

  const extractBitrixLinks = (text) => {
    if (!text) return { links: [], cleaned: '' };
    const links = [];
    const cleaned = text.replace(/(https?:\/\/[^\s\n]+)/g, (url) => {
      if (url.includes('bitrix')) links.push(url.trim());
      return '';
    }).trim();
    return { links, cleaned };
  };

  const showLoader = () => document.getElementById('global-loader').classList.add('active');
  const hideLoader = () => document.getElementById('global-loader').classList.remove('active');
  
  const normalizeRole = (role) => String(role || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const hasRole = (role) => (ROLE_RANK[normalizeRole(App.currentUser?.papel)] || 0) >= (ROLE_RANK[normalizeRole(role)] || 0);
  const canCreateTask = () => hasRole('analista');
  const canEditTask = () => hasRole('analista');
  const canDeleteTask = () => hasRole('administrador');
  const canCommentTask = () => !!App.sessionToken && !!App.currentUser;
  const canDeleteComment = (comment) => canEditTask() || [App.currentUser?.nome, App.currentUser?.email].filter(Boolean).includes(comment?.autor);
  const canManageStructure = () => hasRole('administrador');
  const canManageUsers = () => hasRole('dev');

  const applyTheme = (theme) => {
    App.theme = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-mode', App.theme === 'light');
    
    const icon = document.getElementById('theme-toggle-icon');
    const text = document.getElementById('theme-toggle-text');
    if (icon) icon.innerHTML = `<i data-lucide="${App.theme === 'light' ? 'moon-star' : 'sun-medium'}" class="icon"></i>`;
    if (text) text.textContent = App.theme === 'light' ? 'Modo Noite' : 'Modo Dia';
    
    try { localStorage.setItem('radar-theme', App.theme); } catch (_) {}
    renderIcons();
  };

  const toggleTheme = () => applyTheme(App.theme === 'light' ? 'dark' : 'light');

  const applySidebarState = (collapsed) => {
    App.sidebarCollapsed = !!collapsed;
    document.getElementById('app-shell')?.classList.toggle('sidebar-collapsed', App.sidebarCollapsed);
    
    const toggle = document.getElementById('sidebar-toggle');
    if (toggle) {
      toggle.title = App.sidebarCollapsed ? 'Expandir menu' : 'Recolher menu';
      toggle.innerHTML = `<i data-lucide="${App.sidebarCollapsed ? 'panel-left-open' : 'panel-left-close'}" class="icon"></i>`;
    }
    try { localStorage.setItem('radar-sidebar-collapsed', App.sidebarCollapsed ? '1' : '0'); } catch (_) {}
    renderIcons();
  };

  const toggleSidebar = () => applySidebarState(!App.sidebarCollapsed);

  const apiFetch = async (params, options = {}) => {
    if (!App.apiUrl) throw new Error('API URL não configurada');
    const { background = false } = options;
    if (!background) showLoader();
    try {
      const res = await fetch(`${App.apiUrl}?${new URLSearchParams({ ...params, token: App.sessionToken || '', deviceId: App.deviceId || '' })}`, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.status === 'error') throw new Error(json.data?.message || 'Erro na API');
      return json.data;
    } finally { 
      if (!background) hideLoader(); 
    }
  };

  const apiFetchJsonp = (params, _options = {}) => new Promise((resolve, reject) => {
    if (!App.apiUrl) return reject(new Error('API URL não configurada'));
    const callbackName = `__radarJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    
    const timeout = setTimeout(() => cleanup(new Error('Tempo esgotado ao consultar a API')), 15000);
    const cleanup = (err, data) => {
      clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
      err ? reject(err) : resolve(data);
    };

    window[callbackName] = (payload) => {
      if (!payload || payload.status === 'error') return cleanup(new Error(payload?.data?.message || 'Erro na API'));
      cleanup(null, payload.data);
    };

    script.onerror = () => cleanup(new Error('Falha ao carregar script da API'));
    script.src = `${App.apiUrl}?${new URLSearchParams({ ...params, token: App.sessionToken || '', deviceId: App.deviceId || '', callback: callbackName })}`;
    document.body.appendChild(script);
  });

  const publicJsonpRequest = (params) => new Promise((resolve, reject) => {
    const callbackName = `__radarPublic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timeout = setTimeout(() => cleanup(new Error('Tempo esgotado ao consultar a autenticação')), 15000);

    const cleanup = (err, data) => {
      clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
      err ? reject(err) : resolve(data);
    };

    window[callbackName] = (payload) => {
      if (!payload || payload.status === 'error') return cleanup(new Error(payload?.data?.message || 'Erro na autenticação'));
      cleanup(null, payload.data);
    };

    script.onerror = () => cleanup(new Error('Falha ao carregar autenticação'));
    script.src = `${App.apiUrl}?${new URLSearchParams({ ...params, callback: callbackName })}`;
    document.body.appendChild(script);
  });

  const getErrorMessage = (error, fallback = 'Falha na autenticação') => {
    if (!error) return fallback;
    if (typeof error === 'string') return error;
    return error?.data?.message || error?.message || fallback;
  };

  const callPublicAuth = async (action, payload) => {
    try {
      const res = await fetch(App.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
      });
      const json = await res.json();
      if (json.status === 'error') throw new Error(json.data?.message || 'Falha na autenticação');
      return json.data;
    } catch (e) {
      if (e?.name !== 'TypeError' && !String(e?.message).includes('Failed to fetch')) throw e;
      return publicJsonpRequest({ action, ...payload });
    }
  };

  const saveSession = (token, user) => {
    App.sessionToken = token || '';
    App.currentUser = user || null;
    try {
      localStorage.setItem('radar-session-token', App.sessionToken);
      localStorage.setItem('radar-session-user', JSON.stringify(App.currentUser));
    } catch (_) {}
  };

  const clearSession = () => {
    App.sessionToken = '';
    App.currentUser = null;
    App.users = [];
    try {
      localStorage.removeItem('radar-session-token');
      localStorage.removeItem('radar-session-user');
    } catch (_) {}
  };

  const persistBootstrapCache = (data) => {
    if (!App.currentUser?.email) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        at: Date.now(),
        userEmail: App.currentUser.email,
        data
      }));
    } catch (_) {}
  };

  const getBootstrapSignature = (data) => {
    try {
      return JSON.stringify({
        tasks: data.tasks || [],
        departments: data.departments || [],
        collaborators: data.collaborators || [],
        users: data.users || []
      });
    } catch (_) {
      return String(Date.now());
    }
  };

  const loadBootstrapCache = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!raw || !raw.at || !raw.data || !App.currentUser?.email) return null;
      if (raw.userEmail !== App.currentUser.email) return null;
      if (Date.now() - raw.at > CACHE_TTL) return null;
      return raw.data;
    } catch (_) {
      return null;
    }
  };

  const syncAppChrome = () => {
    applyFilters();
    renderStats();
    renderBoard();
    buildTeamChips();
    buildResponsibleChips();
    syncPrimaryAction();
    applyAccessControls();
    syncViewChrome();
    document.getElementById('config-banner').style.display = 'none';
    renderIcons();
  };

  const showAuthShell = (mode = 'login', payload = {}) => {
    App.authMode = mode;
    stopAutoRefresh();
    document.getElementById('auth-shell').classList.add('active');
    document.getElementById('app-shell').classList.add('app-hidden');
    renderAuthForm(mode, payload);
    renderIcons();
  };

  const showAppShell = () => {
    document.getElementById('auth-shell').classList.remove('active');
    document.getElementById('app-shell').classList.remove('app-hidden');
    startAutoRefresh();
    renderIcons();
  };

  const renderAuthForm = (mode, payload = {}) => {
    const form = document.getElementById('auth-form');
    const title = document.getElementById('auth-title');
    const copy = document.getElementById('auth-copy');
    if (mode === 'forgot') {
      title.textContent = 'Recuperar senha';
      copy.textContent = 'Envie um código para o e-mail cadastrado e redefina a senha com segurança.';
      form.innerHTML = `
        <div class="auth-form-card">
          <div class="auth-input-wrap">
            <label class="auth-form-label">E-mail cadastrado</label>
            <input class="form-input" id="auth-email" type="email" placeholder="seu.email@empresa.com" value="${escAttr(payload.email || '')}" />
          </div>
          <div class="auth-actions" style="margin-top:14px">
            <button class="btn-save" onclick="requestPasswordResetFlow()"><span class="btn-content"><i data-lucide="send" class="icon"></i>Enviar código</span></button>
            <button class="btn-outline" onclick="showAuthShell('reset', { email: document.getElementById('auth-email')?.value || '' })">Já tenho código</button>
          </div>
        </div>
        <div class="auth-link" onclick="showAuthShell('login')">Voltar para login</div>
      `;
      bindAuthKeyboard('forgot');
      renderIcons();
      return;
    }
    if (mode === 'reset') {
      title.textContent = 'Redefinir senha';
      copy.textContent = 'Digite o código enviado ao e-mail cadastrado e defina uma nova senha.';
      form.innerHTML = `
        <div class="auth-form-card">
          <div class="auth-input-wrap">
            <label class="auth-form-label">E-mail cadastrado</label>
            <input class="form-input" id="auth-email" type="email" placeholder="seu.email@empresa.com" value="${escAttr(payload.email || '')}" />
          </div>
          <div class="auth-input-wrap">
            <label class="auth-form-label">Código</label>
            <input class="form-input" id="auth-code" type="text" placeholder="Código de 6 dígitos" />
          </div>
          <div class="auth-input-wrap">
            <label class="auth-form-label">Nova senha</label>
            <input class="form-input" id="auth-new-password" type="password" placeholder="Nova senha" />
          </div>
          <div class="auth-actions" style="margin-top:14px">
            <button class="btn-save" onclick="resetPasswordFlow()"><span class="btn-content"><i data-lucide="lock-keyhole" class="icon"></i>Atualizar senha</span></button>
            <button class="btn-outline" onclick="showAuthShell('login')">Cancelar</button>
          </div>
        </div>
      `;
      bindAuthKeyboard('reset');
      renderIcons();
      return;
    }
    if (mode === 'verify') {
      title.textContent = 'Verificar e-mail';
      copy.textContent = 'No primeiro acesso, confirme o código enviado ao e-mail cadastrado antes de entrar no radar.';
      form.innerHTML = `
        <div class="auth-form-card">
          <div class="auth-input-wrap">
            <label class="auth-form-label">E-mail cadastrado</label>
            <input class="form-input" id="auth-email" type="email" placeholder="seu.email@empresa.com" value="${escAttr(payload.email || '')}" />
          </div>
          <div class="auth-input-wrap">
            <label class="auth-form-label">Código de verificação</label>
            <input class="form-input" id="auth-code" type="text" placeholder="Código de 6 dígitos" />
          </div>
          <div class="auth-actions" style="margin-top:14px">
            <button class="btn-save" onclick="verifyEmailFlow()"><span class="btn-content"><i data-lucide="shield-check" class="icon"></i>Validar e-mail</span></button>
            <button class="btn-outline" onclick="sendEmailVerificationFlow()">Reenviar código</button>
          </div>
        </div>
        <div class="auth-link" onclick="showAuthShell('login')">Voltar para login</div>
      `;
      bindAuthKeyboard('verify');
      renderIcons();
      return;
    }
    title.textContent = 'Entrar';
    copy.textContent = 'Use suas credenciais já cadastradas para acessar o radar.';
    form.innerHTML = `
      <div class="auth-form-card">
        <div class="auth-input-wrap">
          <label class="auth-form-label">E-mail cadastrado</label>
          <input class="form-input" id="auth-email" type="email" placeholder="seu.email@empresa.com" />
        </div>
        <div class="auth-input-wrap">
          <label class="auth-form-label">Senha</label>
          <div class="password-field">
            <input class="form-input" id="auth-password" type="${App.authPasswordVisible ? 'text' : 'password'}" placeholder="Sua senha" />
            <button class="password-toggle" type="button" onclick="toggleAuthPassword()" aria-label="Mostrar ou esconder senha">
              <i data-lucide="${App.authPasswordVisible ? 'eye-off' : 'eye'}" class="icon"></i>
            </button>
          </div>
        </div>
        <div class="auth-actions" style="margin-top:14px">
          <button class="btn-save${App.authLoading ? ' is-loading' : ''}" id="login-submit-btn" onclick="loginFlow()">
            <span class="btn-content">${App.authLoading ? '<span class="spinner"></span>Validando...' : '<i data-lucide="log-in" class="icon"></i>Entrar no Radar'}</span>
          </button>
        </div>
      </div>
      <div class="auth-actions">
        <div class="auth-link" onclick="showAuthShell('forgot')">Esqueci minha senha</div>
      </div>
    `;
    bindAuthKeyboard('login');
    renderIcons();
  };

  const bindAuthKeyboard = (mode) => {
    const form = document.getElementById('auth-form');
    if (!form) return;
    form.onkeydown = (event) => {
      if (event.key !== 'Enter') return;
      if (event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      if (mode === 'login') loginFlow();
      if (mode === 'reset') resetPasswordFlow();
      if (mode === 'forgot') requestPasswordResetFlow();
      if (mode === 'verify') verifyEmailFlow();
    };
  };

  const setAuthLoading = (loading) => {
    const email = document.getElementById('auth-email')?.value || '';
    const password = document.getElementById('auth-password')?.value || '';
    App.authLoading = !!loading;
    if (App.authMode === 'login') {
      renderAuthForm('login');
      const emailEl = document.getElementById('auth-email');
      const passwordEl = document.getElementById('auth-password');
      if (emailEl) emailEl.value = email;
      if (passwordEl) passwordEl.value = password;
    }
  };

  const toggleAuthPassword = () => {
    const email = document.getElementById('auth-email')?.value || '';
    const password = document.getElementById('auth-password')?.value || '';
    App.authPasswordVisible = !App.authPasswordVisible;
    if (App.authMode === 'login') {
      renderAuthForm('login');
      const emailEl = document.getElementById('auth-email');
      const passwordEl = document.getElementById('auth-password');
      if (emailEl) emailEl.value = email;
      if (passwordEl) passwordEl.value = password;
      passwordEl?.focus();
    }
  };

  const validateCorporateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  const normalizeAuthMessage = (message) => String(message || '')
    .toLowerCase()
    .replace(/ã£/g, 'a')
    .replace(/ã¡/g, 'a')
    .replace(/ã¢/g, 'a')
    .replace(/ã©/g, 'e')
    .replace(/ãª/g, 'e')
    .replace(/ã­/g, 'i')
    .replace(/ã³/g, 'o')
    .replace(/ãµ/g, 'o')
    .replace(/ãº/g, 'u')
    .replace(/ã§/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const isEmailVerificationError = (message) => {
    const text = normalizeAuthMessage(message);
    return text.includes('nao foi verificado') || text.includes('email ainda nao');
  };

  const isSessionConflictError = (message) => {
    const text = normalizeAuthMessage(message);
    return text.includes('outro dispositivo') ||
      text.includes('sessao ativa') ||
      text.includes('ja esta logado') ||
      text.includes('usuario ja logado');
  };

  const isSessionInvalidationError = (message) => {
    const text = normalizeAuthMessage(message);
    return text.includes('sessao invalidada') || text.includes('outro dispositivo');
  };

  const isSessionExpiredError = (message) => {
    const text = normalizeAuthMessage(message);
    return text.includes('sessao invalida') ||
      text.includes('sessao expirada') ||
      text.includes('usuario sem acesso');
  };

  const executeLogin = async (email, password, replaceActiveSession = false) => {
    return callPublicAuth('login', {
      email,
      password,
      deviceId: App.deviceId,
      replaceActiveSession
    });
  };

  const loginNeedsConfirmation = (data) => {
    return !!(data && (
      data.requiresConfirmation ||
      data.confirmReplaceSession ||
      data.sessionConflict
    ));
  };

  const loginFlow = async () => {
    if (App.authLoading) return;
    const email = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value || '';
    
    if (!validateCorporateEmail(email)) return toast('Informe um e-mail válido.', 'warning');
    if (!password) return toast('Informe sua senha.', 'warning');
    
    setAuthLoading(true);
    showLoader();
    try {
      let data;
      try {
        data = await executeLogin(email, password, false);
      } catch (e) {
        if (isEmailVerificationError(getErrorMessage(e))) {
          showAuthShell('verify', { email });
          toast('Seu e-mail ainda não foi verificado. Digite o código enviado para concluir o primeiro acesso.', 'warning', 5000);
          return;
        }
        if (!isSessionConflictError(getErrorMessage(e))) throw e;
        const confirmed = confirm('Este usuario ja esta logado em outro dispositivo. Continuar e desconectar a outra sessao?');
        if (!confirmed) return;
        data = await executeLogin(email, password, true);
      }
      if (loginNeedsConfirmation(data)) {
        const confirmed = confirm('Este usuario ja esta logado em outro dispositivo. Continuar e desconectar a outra sessao?');
        if (!confirmed) return;
        data = await executeLogin(email, password, true);
      }
      saveSession(data.token, data.user);
      await loadTasks({ useCache: true });
      showAppShell();
      toast(`Sessão iniciada para ${data.user.nome || data.user.email}`, 'success');
    } catch (e) {
      toast('Login falhou: ' + getErrorMessage(e), 'error', 5000);
    } finally {
      setAuthLoading(false);
      hideLoader();
    }
  };

  const requestPasswordResetFlow = async () => {
    const email = document.getElementById('auth-email')?.value.trim();
    if (!validateCorporateEmail(email)) return toast('Informe um e-mail válido.', 'warning');
    
    try {
      await callPublicAuth('requestPasswordReset', { email });
      toast('Se o e-mail existir, o código foi enviado.', 'success', 4500);
      showAuthShell('reset', { email });
    } catch (e) {
      toast('Não foi possível iniciar a recuperação: ' + getErrorMessage(e), 'error');
    }
  };

  const resetPasswordFlow = async () => {
    const email = document.getElementById('auth-email')?.value.trim();
    const code = document.getElementById('auth-code')?.value.replace(/\D/g, '').trim();
    const newPassword = document.getElementById('auth-new-password')?.value || '';
    if (!validateCorporateEmail(email)) return toast('Informe um e-mail válido.', 'warning');
    if (!code) return toast('Informe o código recebido.', 'warning');
    if (newPassword.length < 8) return toast('A nova senha precisa ter pelo menos 8 caracteres.', 'warning');
    try {
      await callPublicAuth('resetPassword', { email, code, newPassword });
      toast('Senha atualizada com sucesso.', 'success');
      showAuthShell('login');
    } catch (e) {
      toast('Não foi possível redefinir a senha: ' + getErrorMessage(e), 'error', 5000);
    }
  };

  const apiPost = async (body, options = {}) => {
    if (!App.apiUrl) return localDemoAction(body);
    const { background = false } = options;

    if (!background) showLoader();
    try {
      const res = await fetch(App.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, token: App.sessionToken || '', deviceId: App.deviceId || '' }),
        keepalive: background,
        redirect: 'follow'
      });
      if (res.type !== 'opaque' && res.ok) {
        const json = await res.json();
        if (json.status === 'error') {
          if (isSessionInvalidationError(json.data?.message)) {
            clearSession();
            showAuthShell('login');
            throw new Error('Sua sessão expirou pois você fez login em outro dispositivo.');
          }
          throw new Error(json.data?.message || 'Erro na API');
        }
        return json.data;
      }
      return null;
    } catch (err) {
      if (err?.name === 'TypeError' || String(err?.message).includes('Failed to fetch')) {
        fetch(App.apiUrl, {
          method: 'POST',
          body: JSON.stringify({ ...body, token: App.sessionToken || '', deviceId: App.deviceId || '' }),
          mode: 'no-cors'
        }).catch(() => {});
        return null;
      }
      throw err;
    } finally {
      if (!background) hideLoader();
    }
  };

  let _demoId = 900;
  const localDemoAction = (body) => {
    switch (body.action) {
      case 'create': {
        const t = { ...body.payload, id: 'demo-' + (++_demoId), data_criacao: new Date().toISOString() };
        App.tasks.push(t);
        return t;
      }
      case 'update': {
        const idx = App.tasks.findIndex(t => t.id === body.payload.id);
        if (idx !== -1) Object.assign(App.tasks[idx], body.payload);
        return App.tasks[idx];
      }
      case 'updateStatus': {
        const t = App.tasks.find(t => t.id === body.id);
        if (t) t.status = body.status;
        return t;
      }
      case 'delete': {
        App.tasks = App.tasks.filter(t => t.id !== body.id);
        return { deleted: body.id };
      }
    }
  };

  const loadTasks = async (options = {}) => {
    if (!App.apiUrl) throw new Error('API URL não configurada');
    const { useCache = false, silent = false, background = false } = options;
    try {
      if (useCache) {
        const cached = loadBootstrapCache();
        if (cached) {
          hydrateAppData(cached);
          App.bootstrappedFromCache = true;
          syncAppChrome();
          showAppShell();
        }
      }
      try {
        const data = await apiFetch({ action: 'bootstrap' }, { background }) || {};
        const signature = getBootstrapSignature(data);
        if (background && signature === App.lastBootstrapSignature) return;
        hydrateAppData(data);
        persistBootstrapCache(data);
        App.lastBootstrapSignature = signature;
      } catch (e) {
        if (e?.name !== 'TypeError' && !String(e?.message).includes('Failed to fetch')) throw e;
        const data = await apiFetchJsonp({ action: 'bootstrap' }, { background }) || {};
        const signature = getBootstrapSignature(data);
        if (background && signature === App.lastBootstrapSignature) return;
        hydrateAppData(data);
        persistBootstrapCache(data);
        App.lastBootstrapSignature = signature;
      }
      App.bootstrappedFromCache = false;
      syncAppChrome();
    } catch(e) {
      if (isSessionInvalidationError(getErrorMessage(e))) {
        clearSession();
        showAuthShell('login');
        toast('Sua sessão expirou pois você fez login em outro dispositivo.', 'error', 8000);
      } else if (isSessionExpiredError(getErrorMessage(e))) {
        clearSession();
        showAuthShell('login');
        toast('Sua sessão expirou. Faça login novamente.', 'warning', 5000);
      } else {
        if (!silent) toast('Erro ao carregar tarefas: ' + e.message, 'error', 6500);
      }
      throw e;
    }
  };

  const hydrateAppData = (data) => {
    const drawerOpen = document.getElementById('drawer')?.classList.contains('open');
    const currentTaskId = App.currentTask?.id;
    App.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    App.departments = Array.isArray(data.departments) ? data.departments : [];
    App.collaborators = Array.isArray(data.collaborators) ? data.collaborators : [];
    App.users = Array.isArray(data.users) ? data.users : [];
    if (data.currentUser) App.currentUser = data.currentUser;
    if (drawerOpen && currentTaskId) {
      const refreshedTask = App.tasks.find(task => String(task.id) === String(currentTaskId));
      if (refreshedTask) App.currentTask = { ...refreshedTask };
    }
    applyAccessControls();
    updateUserPill();
  };

  const performAutoRefresh = async () => {
    if (App.autoRefreshInFlight || !App.sessionToken || document.hidden) return;
    App.autoRefreshInFlight = true;
    try {
      await loadTasks({ silent: true, background: true });
    } catch (_) {
    } finally {
      App.autoRefreshInFlight = false;
    }
  };

  const sendEmailVerificationFlow = async () => {
    const email = document.getElementById('auth-email')?.value.trim();
    if (!validateCorporateEmail(email)) return toast('Informe um e-mail válido.', 'warning');
    try {
      await callPublicAuth('sendEmailVerification', { email });
      toast('Código de verificação enviado.', 'success', 4000);
      showAuthShell('verify', { email });
    } catch (e) {
      toast('Não foi possível enviar o código: ' + getErrorMessage(e), 'error', 5000);
    }
  };

  const verifyEmailFlow = async () => {
    const email = document.getElementById('auth-email')?.value.trim();
    const code = document.getElementById('auth-code')?.value.replace(/\D/g, '').trim();
    if (!validateCorporateEmail(email)) return toast('Informe um e-mail válido.', 'warning');
    if (!code) return toast('Informe o código de verificação.', 'warning');
    try {
      await callPublicAuth('verifyEmail', { email, code });
      toast('E-mail verificado com sucesso. Agora você já pode entrar.', 'success', 4500);
      showAuthShell('login');
      const emailEl = document.getElementById('auth-email');
      if (emailEl) emailEl.value = email;
      document.getElementById('auth-password')?.focus();
    } catch (e) {
      toast('Não foi possível validar o código: ' + getErrorMessage(e), 'error', 5000);
    }
  };

  const stopAutoRefresh = () => {
    if (App.autoRefreshTimer) clearInterval(App.autoRefreshTimer);
    App.autoRefreshTimer = null;
    App.autoRefreshInFlight = false;
  };

  const startAutoRefresh = () => {
    if (App.autoRefreshTimer || !App.sessionToken) return;
    App.autoRefreshTimer = setInterval(performAutoRefresh, 3000);
  };

  const requestConfirm = ({ title = 'Confirmar ação', message = 'Tem certeza?', confirmLabel = 'Confirmar' } = {}) => {
    const overlay = document.getElementById('confirm-overlay');
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    if (!overlay || !modal || !titleEl || !messageEl || !okBtn || !cancelBtn) {
      return Promise.resolve(window.confirm(message));
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = confirmLabel;

    overlay.classList.add('open');
    modal.classList.add('open');

    return new Promise(resolve => {
      const close = (result) => {
        overlay.classList.remove('open');
        modal.classList.remove('open');
        overlay.onclick = null;
        cancelBtn.onclick = null;
        okBtn.onclick = null;
        App.confirmResolver = null;
        resolve(result);
      };

      App.confirmResolver = close;
      overlay.onclick = () => close(false);
      cancelBtn.onclick = () => close(false);
      okBtn.onclick = () => close(true);
    });
  };

  const applyAccessControls = () => {
    document.getElementById('btn-primary-action')?.classList.toggle('view-hidden', !canCreateTask() && isTaskView(App.currentView));
    const missingBtn = document.getElementById('btn-missing-mapping');
    if (missingBtn) missingBtn.classList.toggle('view-hidden', !isTaskView(App.currentView));
    document.getElementById('nav-access')?.classList.toggle('view-hidden', !canManageUsers());
  };

  const syncViewChrome = () => {
    document.getElementById('stats-row')?.classList.toggle('view-hidden', App.currentView !== 'kanban');
    document.getElementById('sidebar-filters')?.classList.toggle('view-hidden', !isTaskView(App.currentView));
  };

  const updateUserPill = () => {
    const pill = document.getElementById('current-user-pill');
    if (!pill) return;
    
    if (!App.currentUser) {
      pill.style.display = 'none';
      pill.textContent = '';
      return;
    }
    pill.style.display = '';
    pill.textContent = `${App.currentUser.nome || App.currentUser.email} • ${App.currentUser.papel}`;
  };

  const logoutFlow = async () => {
    if (App.sessionToken && App.apiUrl) {
      try {
        await callPublicAuth('logout', { token: App.sessionToken, deviceId: App.deviceId });
      } catch(e) {
        console.warn('Falha ao deslogar no servidor', e);
      }
    }
    stopAutoRefresh();
    clearSession();
    updateUserPill();
    showAuthShell('login');
    toast('Sessão encerrada.', 'info');
  };

  const refreshData = async () => {
    toast('Atualizando dados...', 'info');
    await loadTasks();
  };

  const applyFilters = () => {
    App.filteredTasks = App.tasks.filter(t => {
      const u = getUrgency(t);
      const statuses = App.filters.statuses.map(v => normalizeTaskStatus(v));
      const teams = App.filters.teams;
      const urgencies = App.filters.urgencies;
      const responsibles = App.filters.responsibles;
      const q = (App.filters.search || '').toLowerCase();
      const status = normalizeTaskStatus(t.status);
      const objetivo = (t.objetivo || '').toLowerCase();
      const responsavel = (t.responsavel || '').toLowerCase();
      const team = String(t.equipe || '');
      const isLegacy = !App.departments.some(d => d.nome === team) || !App.collaborators.some(c => c.nome === t.responsavel);

      if (statuses.length && !statuses.includes(status)) return false;
      if (teams.length && !teams.some(sel => team.toUpperCase() === String(sel).toUpperCase())) return false;
      if (urgencies.length && !urgencies.includes(u)) return false;
      if (responsibles.length && !responsibles.some(sel => String(t.responsavel || '').toUpperCase() === String(sel).toUpperCase())) return false;
      if (App.filters.legacyOnly && !isLegacy) return false;
      if (q && !objetivo.includes(q) && !responsavel.includes(q)) return false;
      return true;
    });
    updateCounts();
  };

  let _searchTimeout;
  const onSearch = (val) => {
    App.filters.search = val;
    clearTimeout(_searchTimeout);
    _searchTimeout = setTimeout(() => {
      if (isTaskView(App.currentView)) applyFilters();
      renderBoard();
    }, 250);
  };

  const updateCounts = () => {
    const n = App.filteredTasks.length;
    document.getElementById('cnt-kanban').textContent = n;
    document.getElementById('cnt-list').textContent = n;
    document.getElementById('cnt-collaborators').textContent = App.collaborators.length;
    document.getElementById('cnt-departments').textContent = App.departments.length;
    document.getElementById('cnt-access').textContent = App.users.length;
    document.getElementById('cnt-sla').textContent = App.departments.length;
    document.getElementById('cnt-indicators').textContent = App.tasks.length;
  };

  const buildTeamChips = () => {
    const teams = [...new Set([
      ...App.departments.map(d => d.nome).filter(Boolean),
      ...App.tasks.map(t => t.equipe).filter(Boolean)
    ])].sort();
    const el = document.getElementById('team-chips');
    const allChip = el.querySelector('.chip[data-team=""]');
    
    el.innerHTML = ''; 
    if (allChip) el.appendChild(allChip);
    else el.innerHTML = '<span class="chip active" data-team="">Todas</span>';

    teams.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.team = t;
      chip.textContent = t;
      el.appendChild(chip);
    });

    bindMultiChipFilter(el, 'team', 'teams');
  };

  const buildResponsibleChips = () => {
    const names = [...new Set(App.collaborators.map(c => c.nome).filter(Boolean).concat(App.tasks.map(t => t.responsavel).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const el = document.getElementById('responsible-chips');
    const allChip = el.querySelector('.chip[data-responsible=""]');
    
    el.innerHTML = '';
    if (allChip) el.appendChild(allChip);
    else el.innerHTML = '<span class="chip active" data-responsible="">Todos</span>';
    
    names.forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.responsible = name;
      chip.textContent = name;
      el.appendChild(chip);
    });
    bindMultiChipFilter(el, 'responsible', 'responsibles');
  };

  const bindMultiChipFilter = (container, key, filterKey) => {
    if (!container || container.dataset.bound === 'true') {
      syncMultiChipState(container, key, filterKey);
      return;
    }
    container.dataset.bound = 'true';
    container.addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if (!c) return;
      const datasetKey = key === 'status' ? 'status' : key === 'team' ? 'team' : key === 'urgency' ? 'urgency' : 'responsible';
      const value = c.dataset[datasetKey];
      if (!value) {
        App.filters[filterKey] = [];
      } else {
        const set = new Set(App.filters[filterKey]);
        if (set.has(value)) set.delete(value);
        else set.add(value);
        App.filters[filterKey] = [...set];
      }
      syncMultiChipState(container, key, filterKey);
      if (isTaskView(App.currentView)) applyFilters();
      renderBoard();
    });
    syncMultiChipState(container, key, filterKey);
  };

  const syncMultiChipState = (container, key, filterKey) => {
    if (!container) return;
    const activeValues = App.filters[filterKey] || [];
    container.querySelectorAll('.chip').forEach(chip => {
      const datasetKey = key === 'status' ? 'status' : key === 'team' ? 'team' : key === 'urgency' ? 'urgency' : 'responsible';
      const value = chip.dataset[datasetKey];
      chip.classList.toggle('active', value ? activeValues.includes(value) : activeValues.length === 0);
    });
  };

  const clearTaskFilters = () => {
    App.filters = { statuses: [], teams: [], urgencies: [], responsibles: [], legacyOnly: false, search: '' };
    const search = document.getElementById('search-input');
    if (search) search.value = '';
    syncMultiChipState(document.getElementById('status-chips'), 'status', 'statuses');
    syncMultiChipState(document.getElementById('team-chips'), 'team', 'teams');
    syncMultiChipState(document.getElementById('urgency-chips'), 'urgency', 'urgencies');
    syncMultiChipState(document.getElementById('responsible-chips'), 'responsible', 'responsibles');
    document.getElementById('btn-missing-mapping')?.classList.remove('active');
    if (isTaskView(App.currentView)) applyFilters();
    renderBoard();
  };

  const toggleLegacyOnly = () => {
    App.filters.legacyOnly = !App.filters.legacyOnly;
    document.getElementById('btn-missing-mapping')?.classList.toggle('active', App.filters.legacyOnly);
    if (isTaskView(App.currentView)) applyFilters();
    renderBoard();
    toast(
      App.filters.legacyOnly
        ? 'Mostrando tarefas com departamento ou responsavel fora do cadastro atual'
        : 'Filtro de pendencias de cadastro desativado',
      'info',
      2600
    );
  };

  const toggleResponsibleFilters = () => {
    const el = document.getElementById('responsible-chips');
    const btn = document.getElementById('responsible-toggle');
    if (!el || !btn) return;
    const isHidden = el.classList.toggle('filter-panel-collapsed');
    btn.textContent = isHidden ? 'Mostrar responsáveis' : 'Ocultar responsáveis';
    btn.classList.toggle('is-open', !isHidden);
  };

  const toggleDepartmentFilters = () => {
    const el = document.getElementById('team-chips');
    const btn = document.getElementById('department-toggle');
    if (!el || !btn) return;
    const isHidden = el.classList.toggle('filter-panel-collapsed');
    btn.textContent = isHidden ? 'Mostrar departamentos' : 'Ocultar departamentos';
    btn.classList.toggle('is-open', !isHidden);
  };

  const focusCollaborator = (name, department) => {
    App.filters.responsibles = name ? [name] : [];
    App.filters.teams = department ? [department] : [];
    App.filters.statuses = [];
    App.filters.urgencies = [];
    App.filters.legacyOnly = false;
    syncMultiChipState(document.getElementById('status-chips'), 'status', 'statuses');
    syncMultiChipState(document.getElementById('team-chips'), 'team', 'teams');
    syncMultiChipState(document.getElementById('urgency-chips'), 'urgency', 'urgencies');
    syncMultiChipState(document.getElementById('responsible-chips'), 'responsible', 'responsibles');
    document.getElementById('btn-missing-mapping')?.classList.remove('active');
    switchView('list');
    applyFilters();
    renderBoard();
    toast(`Mostrando tarefas de ${name}`, 'info', 1800);
  };

  const openCollaboratorPanel = (name) => {
    App.indicatorFocus = name || '';
    switchView('indicators');
    renderBoard();
    toast(`Painel focado em ${name}`, 'info', 1800);
  };

  bindMultiChipFilter(document.getElementById('status-chips'), 'status', 'statuses');
  bindMultiChipFilter(document.getElementById('urgency-chips'), 'urgency', 'urgencies');

  const isTaskView = (view) => view === 'kanban' || view === 'list';

  const syncPrimaryAction = () => {
    const meta = VIEW_META[App.currentView] || VIEW_META.kanban;
    const btn = document.getElementById('btn-primary-action');
    const sectionActions = document.querySelector('.section-actions');
    btn.innerHTML = meta.action ? `<span class="btn-content"><i data-lucide="plus" class="icon"></i>${escHtml(meta.action.replace(/^\+\s*/, ''))}</span>` : '';
    btn.classList.toggle('view-hidden', !meta.action);
    if (sectionActions) sectionActions.classList.toggle('view-hidden', !meta.sectionActions);
    document.getElementById('view-title').textContent = meta.title;
    renderIcons();
  };

  const switchView = (v) => {
    if (App.currentView === 'indicators' && v !== 'indicators') App.indicatorFocus = '';
    App.currentView = v;
    ['kanban','list','collaborators','departments','access','sla','indicators'].forEach(view => {
      const nav = document.getElementById(`nav-${view}`);
      if (nav) nav.classList.toggle('active', v === view);
    });
    document.getElementById('btn-view-kanban').classList.toggle('active', v === 'kanban');
    document.getElementById('btn-view-list').classList.toggle('active', v === 'list');
    syncPrimaryAction();
    applyAccessControls();
    syncViewChrome();
    renderBoard();
  };

  const renderStats = () => {
    const tasks = App.tasks;
    let total = tasks.length, atrasados = 0, vencem = 0, concluidos = 0;
    
    tasks.forEach(t => {
      const u = getUrgency(t);
      if (u === 'atrasado') atrasados++;
      if (u === 'hoje') vencem++;
      if (u === 'concluido') concluidos++;
    });

    const ativos = App.collaborators.filter(c => (c.status || 'Ativo') === 'Ativo').length;
    const departamentosAtivos = App.departments.filter(d => String(d.ativo || 'true') !== 'false').length;

    const statsEl = document.getElementById('stats-row');
    statsEl.innerHTML = `
      <div class="stat-card" data-type="total" onclick="applyQuickMetricFilter('all')">
        <div class="stat-icon" style="background:var(--accent-dim);font-size:18px">📊</div>
        <div class="stat-value" style="color:var(--accent)">${total}</div>
        <div class="stat-label">Total de Tarefas</div>
        <div class="stat-trend">Todas as equipes</div>
      </div>
      <div class="stat-card" data-type="atrasado" onclick="applyQuickMetricFilter('atrasado')">
        <div class="stat-icon" style="background:var(--red-dim);font-size:18px">⚠️</div>
        <div class="stat-value" style="color:var(--red)">${atrasados}</div>
        <div class="stat-label">Atrasadas</div>
        <div class="stat-trend">Requerem atenção imediata</div>
      </div>
      <div class="stat-card" data-type="hoje" onclick="applyQuickMetricFilter('hoje')">
        <div class="stat-icon" style="background:var(--yellow-dim);font-size:18px">📅</div>
        <div class="stat-value" style="color:var(--yellow)">${vencem}</div>
        <div class="stat-label">Vencem Hoje</div>
        <div class="stat-trend">Prazo no dia de hoje</div>
      </div>
      <div class="stat-card" data-type="concluido" onclick="applyQuickMetricFilter('concluido')">
        <div class="stat-icon" style="background:var(--green-dim);font-size:18px">✅</div>
        <div class="stat-value" style="color:var(--green)">${concluidos}</div>
        <div class="stat-label">Finalizadas</div>
        <div class="stat-trend">${total ? Math.round(concluidos/total*100) : 0}% do total</div>
      </div>
      <div class="stat-card" data-type="total">
        <div class="stat-icon" style="background:var(--blue-dim);font-size:18px">👥</div>
        <div class="stat-value" style="color:var(--blue)">${ativos}</div>
        <div class="stat-label">Colaboradores Ativos</div>
        <div class="stat-trend">Base operacional cadastrada</div>
      </div>
      <div class="stat-card" data-type="hoje">
        <div class="stat-icon" style="background:var(--purple-dim);font-size:18px">🏢</div>
        <div class="stat-value" style="color:var(--purple)">${departamentosAtivos}</div>
        <div class="stat-label">Departamentos</div>
        <div class="stat-trend">Com SLA configurável</div>
      </div>
    `;
  };

  const renderBoard = () => {
    const viewMap = {
      kanban: renderKanban, list: renderList, collaborators: renderCollaborators,
      departments: renderDepartments, access: renderAccess, sla: renderSla, indicators: renderIndicators
    };
    if (viewMap[App.currentView]) viewMap[App.currentView]();
    renderIcons();
  };

  const applyQuickMetricFilter = (metric) => {
    if (!isTaskView(App.currentView)) switchView('kanban');
    if (metric === 'all') {
      clearTaskFilters();
      return;
    }
    App.filters.urgencies = metric === 'concluido' ? [] : [metric];
    App.filters.statuses = metric === 'concluido' ? ['Finalizado'] : [];
    syncMultiChipState(document.getElementById('status-chips'), 'status', 'statuses');
    syncMultiChipState(document.getElementById('urgency-chips'), 'urgency', 'urgencies');
    applyFilters();
    renderBoard();
  };

  const renderKanban = () => {
    const container = document.getElementById('board-container');
    const byCol = {};
    COLUMNS.forEach(c => byCol[c.id] = []);
    App.filteredTasks.forEach(t => {
      const col = byCol[normalizeTaskStatus(t.status)];
      if (col) col.push(t);
    });

    container.innerHTML = `<div class="kanban-board">${
      COLUMNS.map(col => `
        <div class="kanban-col" id="col-${col.id.replace(/ /g,'-')}"
             ondragover="onDragOver(event,this)" ondrop="onDrop(event,'${col.id}')"
             ondragleave="onDragLeave(event,this)">
          <div class="kanban-header">
            <div class="col-dot" style="background:${col.dot}"></div>
            <div class="col-title" style="color:${col.color}">${col.label}</div>
            <div class="col-count">${byCol[col.id].length}</div>
          </div>
          <div class="kanban-cards" id="cards-${col.id.replace(/ /g,'-')}">
            ${byCol[col.id].length === 0
              ? `<div class="empty-col"><div class="empty-col-icon">☁️</div>Nenhuma tarefa</div>`
              : byCol[col.id].map(t => renderTaskCard(t)).join('')
            }
          </div>
        </div>
      `).join('')
    }</div>`;

    container.querySelectorAll('.task-card').forEach(el => {
      el.setAttribute('draggable', canEditTask() ? 'true' : 'false');
      if (canEditTask()) {
        el.addEventListener('dragstart', e => onDragStart(e, el.dataset.id));
        el.addEventListener('dragend',   () => onDragEnd(el));
      }
      el.addEventListener('click', () => openTaskDrawer(el.dataset.id));
    });
  };

  const renderTaskCard = (t) => {
    const u = getUrgency(t);
    const label = isFinishedStatus(t.status) ? getFinishedStatusLabel(t) : urgencyLabel(u);
    const initials = (t.responsavel || '?').split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
    const prazoStr = formatTaskDate(t.prazo_conclusao, '—');
    const prog = progressInfo(t) || null;
    const comments = parseJsonSafe(t.comentarios);
    
    const progBar = prog ? `
      <div class="card-progress">
        <div class="progress-label">
          <span class="progress-text">${prog.done}/${prog.total} subtarefas</span>
          <span class="progress-pct">${prog.pct}%</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${prog.pct}%"></div>
        </div>
      </div>` : '';

    return `<div class="task-card" data-id="${t.id}" data-urgency="${u}">
      <div class="card-main">
        <div class="card-top">
          <div class="card-urgency-tag urgency-${u}">${label}</div>
        </div>
        <div class="card-title">${escHtml(t.objetivo)}</div>
        <div class="card-meta">
          <div class="card-avatar">${initials}</div>
        <div class="card-responsible">${escHtml(t.responsavel || '—')}</div>
          <div class="card-date"><i data-lucide="calendar-days" class="icon icon-sm"></i>${prazoStr}</div>
        </div>
      </div>
      ${comments.length ? `<div class="management-meta" style="margin-top:10px"><span class="meta-pill"><i data-lucide="messages-square" class="icon icon-sm"></i>${comments.length} comentário${comments.length > 1 ? 's' : ''}</span></div>` : ''}
      ${progBar}
    </div>`;
  };

  const renderList = () => {
    const container = document.getElementById('board-container');
    if (!App.filteredTasks.length) {
      container.innerHTML = `<div class="list-view" style="padding:40px;text-align:center;color:var(--text-muted)">Nenhuma tarefa encontrada</div>`;
      return;
    }
    container.innerHTML = `<div class="list-view"><table class="list-table">
      <thead><tr>
        <th>Tarefa</th><th>Equipe</th><th>Responsável</th>
        <th>Prazo</th><th>Status</th><th>Urgência</th>
      </tr></thead>
      <tbody>${App.filteredTasks.map(t => {
        const u = getUrgency(t);
        const label = isFinishedStatus(t.status) ? getFinishedStatusLabel(t) : urgencyLabel(u);
        const prazoStr = formatTaskDate(t.prazo_conclusao, '—');
        const stCls = 'tag-status-' + normalizeTaskStatus(t.status || 'Não iniciado').toLowerCase().replace(/ /g,'-').replace('ã','a').replace('é','e').replace('ó','o').replace('í','i');
        return `<tr class="task-row" data-id="${t.id}">
          <td class="cell-title"><div class="cell-title-text">${escHtml(t.objetivo)}</div></td>
          <td><span class="tag tag-equipe">${escHtml(t.equipe || '—')}</span></td>
          <td style="color:var(--text-secondary);font-size:0.78rem">${escHtml(t.responsavel || '—')}</td>
          <td style="color:var(--text-muted);font-size:0.78rem">${prazoStr}</td>
          <td><span class="tag ${stCls}">${escHtml(t.status)}</span></td>
          <td><span style="font-size:0.78rem">${label}</span>${parseJsonSafe(t.comentarios).length ? `<div class="management-subtitle">• ${parseJsonSafe(t.comentarios).length}</div>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;

    container.querySelectorAll('.task-row').forEach(row => {
      row.addEventListener('click', () => openTaskDrawer(row.dataset.id));
    });
  };

  const filterBySearch = (items, fields) => {
    const q = (App.filters.search || '').toLowerCase().trim();
    if (!q) return items;
    return items.filter(item => fields.some(field => String(item[field] || '').toLowerCase().includes(q)));
  };

  const getDepartmentMetrics = (depName) => {
    const tasks = App.tasks.filter(t => t.equipe === depName);
    const metrics = tasks.reduce((acc, t) => {
      const status = normalizeTaskStatus(t.status);
      if (status === 'Não iniciado') acc.statuses.naoIniciado++;
      else if (status === 'Em andamento') acc.statuses.andamento++;
      else if (status === 'Em pausa') acc.statuses.pausa++;
      else if (status === 'Finalizado') acc.statuses.finalizado++;
      
      const urgency = getUrgency(t);
      if (urgency === 'atrasado') acc.atrasadas++;
      else if (['hoje', 'futuro', 'concluido'].includes(urgency)) acc.noPrazo++;
      
      return acc;
    }, { statuses: { naoIniciado: 0, andamento: 0, pausa: 0, finalizado: 0 }, atrasadas: 0, noPrazo: 0 });
    
    const conclusao = tasks.length ? Math.round((metrics.statuses.finalizado / tasks.length) * 100) : 0;
    const slaHealth = tasks.length ? Math.round((metrics.noPrazo / tasks.length) * 100) : 0;
    return { tasks, statuses: metrics.statuses, atrasadas: metrics.atrasadas, noPrazo: metrics.noPrazo, conclusao, slaHealth };
  };

  const getStatusTone = (value, inverse = false) => {
    if (inverse) return value > 0 ? 'var(--red)' : 'var(--green)';
    if (value >= 75) return 'var(--green)';
    if (value >= 45) return 'var(--yellow)';
    return 'var(--red)';
  };

  const renderExecutiveHero = (title, copy, kpis, insights) => {
    return `
      <div class="hero-panel">
        <div class="hero-card">
          <div class="hero-eyebrow">Visão Geral</div>
          <div class="hero-title">${title}</div>
          <div class="hero-copy">${copy}</div>
          <div class="hero-kpis">
            ${kpis.map(kpi => `
              <div class="hero-kpi">
                <div class="hero-kpi-value" style="color:${kpi.color || 'var(--text-primary)'}">${kpi.value}</div>
                <div class="hero-kpi-label">${kpi.label}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="hero-card">
          <div class="hero-eyebrow">Leituras rápidas</div>
          <div class="insight-list">
            ${insights.map(item => `
              <div class="insight-item">
                <div class="insight-label">${item.label}</div>
                <div class="insight-value" style="color:${item.color || 'var(--text-primary)'}">${item.value}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  };

  const renderCollaborators = () => {
    const container = document.getElementById('board-container');
    const items = filterBySearch(App.collaborators, ['nome', 'email', 'departamento', 'cargo']);
    if (!items.length) {
      container.innerHTML = `<div class="list-view" style="padding:40px;text-align:center;color:var(--text-muted)">Nenhum colaborador cadastrado</div>`;
      return;
    }
    const totalActive = items.filter(c => (c.status || 'Ativo') === 'Ativo').length;
    const hero = renderExecutiveHero(
      'Pessoas com contexto, carga e ação direta.',
      'Cada card reúne carteira, risco e desempenho da pessoa. Você pode abrir as tarefas dela, entrar no painel individual ou editar o cadastro.',
      [
        { value: items.length, label: 'Colaboradores visíveis', color: 'var(--accent)' },
        { value: totalActive, label: 'Ativos agora', color: 'var(--green)' },
        { value: [...new Set(items.map(c => c.departamento).filter(Boolean))].length, label: 'Departamentos cobertos', color: 'var(--blue)' }
      ],
      [
        { label: 'Maior carteira', value: items.map(c => ({ nome:c.nome, total:App.tasks.filter(t => t.responsavel === c.nome).length })).sort((a,b)=>b.total-a.total)[0]?.nome || '—' },
        { label: 'Mais atrasos', value: items.map(c => ({ nome:c.nome, total:App.tasks.filter(t => t.responsavel === c.nome && getUrgency(t)==='atrasado').length })).sort((a,b)=>b.total-a.total)[0]?.nome || '—', color: 'var(--red)' },
        { label: 'Cadastro', value: canManageStructure() ? 'Use + Novo Colaborador' : 'Somente visualização', color: 'var(--yellow)' }
      ]
    );
    container.innerHTML = `${hero}<div class="management-grid">${items.map(c => {
      const totalTasks = App.tasks.filter(t => t.responsavel === c.nome).length;
      const finished = App.tasks.filter(t => t.responsavel === c.nome && isFinishedStatus(t.status)).length;
      const delayed = App.tasks.filter(t => t.responsavel === c.nome && getUrgency(t) === 'atrasado').length;
      const initials = String(c.nome || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      return `
      <div class="management-card is-clickable" onclick="focusCollaborator('${escAttr(c.nome)}','${escAttr(c.departamento || '')}')">
        <div class="management-top">
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div class="collab-card-accent">${initials}</div>
            <div>
            <div class="management-title">${escHtml(c.nome)}</div>
            <div class="management-subtitle">${escHtml(c.email || 'Sem e-mail')}</div>
            </div>
          </div>
          <span class="tag ${c.status === 'Ativo' ? 'tag-status-finalizado' : 'tag-status-em-pausa'}">${escHtml(c.status || 'Ativo')}</span>
        </div>
        <div class="management-meta">
          <span class="meta-pill">${escHtml(c.departamento || 'Sem departamento')}</span>
          <span class="meta-pill">${escHtml(c.cargo || 'Sem cargo')}</span>
          <span class="meta-pill">${totalTasks} tarefas</span>
        </div>
        <div class="dept-card-grid">
          <div class="dept-stat">
            <div class="dept-stat-label">KPI</div>
            <div class="dept-stat-value" style="color:${getStatusTone(totalTasks ? Math.round((finished / totalTasks) * 100) : 0)}">${totalTasks ? Math.round((finished / totalTasks) * 100) : 0}%</div>
          </div>
          <div class="dept-stat">
            <div class="dept-stat-label">Atrasadas</div>
            <div class="dept-stat-value" style="color:${delayed ? 'var(--red)' : 'var(--green)'}">${delayed}</div>
          </div>
        </div>
        <div class="management-actions">
          <button class="btn-tiny" onclick="event.stopPropagation();focusCollaborator('${escAttr(c.nome)}','${escAttr(c.departamento || '')}')">Ver tarefas</button>
          <button class="btn-tiny" onclick="event.stopPropagation();openCollaboratorPanel('${escAttr(c.nome)}')">Painel</button>
          <button class="btn-tiny" onclick="event.stopPropagation();openCollaboratorDrawer('${c.id}')">Editar</button>
        </div>
      </div>
    `;
    }).join('')}</div>`;
  };

  const renderDepartments = () => {
    const container = document.getElementById('board-container');
    const items = filterBySearch(App.departments, ['nome', 'descricao']);
    if (!items.length) {
      container.innerHTML = `<div class="list-view" style="padding:40px;text-align:center;color:var(--text-muted)">Nenhum departamento cadastrado</div>`;
      return;
    }
    const departmentTaskCount = items.reduce((acc, dep) => acc + App.tasks.filter(t => t.equipe === dep.nome).length, 0);
    const hero = renderExecutiveHero(
      'Arquitetura de departamentos com leitura operacional.',
      'Visual de gestão para enxergar volume, saúde de SLA, concentração de tarefas e impacto de cada departamento sem perder o contexto de execução.',
      [
        { value: items.length, label: 'Departamentos mapeados', color: 'var(--accent)' },
        { value: departmentTaskCount, label: 'Tarefas distribuídas', color: 'var(--blue)' },
        { value: App.collaborators.length, label: 'Colaboradores na estrutura', color: 'var(--green)' }
      ],
      [
        { label: 'Maior carteira', value: items.map(d => ({ nome:d.nome, total: App.tasks.filter(t => t.equipe === d.nome).length })).sort((a,b)=>b.total-a.total)[0]?.nome || '—' },
        { label: 'Mais pressão', value: items.map(d => ({ nome:d.nome, total: App.tasks.filter(t => t.equipe === d.nome && getUrgency(t)==='atrasado').length })).sort((a,b)=>b.total-a.total)[0]?.nome || '—', color: 'var(--red)' },
        { label: 'Melhor saúde', value: items.map(d => ({ nome:d.nome, health:getDepartmentMetrics(d.nome).slaHealth })).sort((a,b)=>b.health-a.health)[0]?.nome || '—', color: 'var(--green)' }
      ]
    );
    container.innerHTML = `${hero}<div class="dept-matrix">${items.map(d => {
      const members = App.collaborators.filter(c => c.departamento === d.nome).length;
      const metrics = getDepartmentMetrics(d.nome);
      return `
        <div class="dept-card">
          <div class="dept-card-top">
            <div>
              <div class="dept-card-title">${escHtml(d.nome)}</div>
              <div class="dept-card-copy">${escHtml(d.descricao || 'Sem descricao cadastrada')}</div>
            </div>
            <span class="tag ${String(d.ativo || 'true') === 'false' ? 'tag-status-em-pausa' : 'tag-status-finalizado'}">${String(d.ativo || 'true') === 'false' ? 'Inativo' : 'Ativo'}</span>
          </div>
          <div class="dept-card-grid">
            <div class="dept-stat">
              <div class="dept-stat-label">SLA</div>
              <div class="dept-stat-value">${escHtml(d.sla_dias || '3')} dias</div>
            </div>
            <div class="dept-stat">
              <div class="dept-stat-label">Colaboradores</div>
              <div class="dept-stat-value">${members}</div>
            </div>
            <div class="dept-stat">
              <div class="dept-stat-label">Tarefas</div>
              <div class="dept-stat-value">${metrics.tasks.length}</div>
            </div>
            <div class="dept-stat">
              <div class="dept-stat-label">Saúde SLA</div>
              <div class="dept-stat-value" style="color:${getStatusTone(metrics.slaHealth)}">${metrics.slaHealth}%</div>
            </div>
          </div>
          <div class="status-cluster">
            <span class="status-badge">NI ${metrics.statuses.naoIniciado}</span>
            <span class="status-badge">Andamento ${metrics.statuses.andamento}</span>
            <span class="status-badge">Pausa ${metrics.statuses.pausa}</span>
            <span class="status-badge">Finalizado ${metrics.statuses.finalizado}</span>
          </div>
          <div style="margin-top:12px">
            <div class="metric-row" style="padding-top:0">
              <span class="metric-name">Conclusão do departamento</span>
              <span class="metric-value" style="font-size:1rem;color:${getStatusTone(metrics.conclusao)}">${metrics.conclusao}%</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${metrics.conclusao}%"></div></div>
          </div>
          <div class="management-actions">
            <button class="btn-tiny" onclick="openDepartmentDrawer('${d.id}')">Editar</button>
          </div>
        </div>
      `;
    }).join('')}</div>`;
  };

  const renderAccess = () => {
    const container = document.getElementById('board-container');
    if (!canManageUsers()) {
      container.innerHTML = `<div class="list-view" style="padding:40px;text-align:center;color:var(--text-muted)">Acesso restrito ao perfil dev</div>`;
      return;
    }
    const items = filterBySearch(App.users, ['nome', 'email', 'papel']);
    const hero = renderExecutiveHero(
      'Controle de acesso do Radar.',
      'Gerencie quem entra no sistema, qual papel cada pessoa possui e quais contas estão ativas ou com e-mail pendente.',
      [
        { value: items.length, label: 'Usuários cadastrados', color: 'var(--accent)' },
        { value: items.filter(u => u.ativo === 'true').length, label: 'Contas ativas', color: 'var(--green)' },
        { value: items.filter(u => u.email_verificado === 'true').length, label: 'E-mails verificados', color: 'var(--blue)' }
      ],
      [
        { label: 'Perfil mais alto', value: items.find(u => u.papel === 'dev')?.nome || '—' },
        { label: 'Pendentes de verificação', value: items.filter(u => u.email_verificado !== 'true').length, color: 'var(--yellow)' },
        { label: 'Contas inativas', value: items.filter(u => u.ativo !== 'true').length, color: 'var(--red)' }
      ]
    );
    container.innerHTML = `${hero}<div class="management-grid">${items.map(user => `
      <div class="management-card">
        <div class="management-top">
          <div>
            <div class="management-title">${escHtml(user.nome || user.email)}</div>
            <div class="management-subtitle">${escHtml(user.email)}</div>
          </div>
          <span class="tag ${user.ativo === 'true' ? 'tag-status-finalizado' : 'tag-status-em-pausa'}">${user.ativo === 'true' ? 'Ativo' : 'Inativo'}</span>
        </div>
        <div class="management-meta">
          <span class="meta-pill">${escHtml(user.papel)}</span>
          <span class="meta-pill">${user.email_verificado === 'true' ? 'Verificado' : 'Pendente'}</span>
        </div>
        <div class="management-actions">
          <button class="btn-tiny" onclick="openUserDrawer('${user.id}')">Editar acesso</button>
        </div>
      </div>
    `).join('')}</div>`;
  };

  const renderSla = () => {
    const container = document.getElementById('board-container');
    const rows = App.departments.map(dep => ({ dep, metrics: getDepartmentMetrics(dep.nome) }))
      .sort((a, b) => b.metrics.atrasadas - a.metrics.atrasadas);
    const onTrack = App.tasks.filter(t => ['hoje','futuro','concluido'].includes(getUrgency(t))).length;
    const overdue = App.tasks.filter(t => getUrgency(t) === 'atrasado').length;
    const hero = renderExecutiveHero(
      'Saúde de SLA em tempo real.',
      'Um cockpit para identificar gargalos por departamento, risco de vencimento e tendência de cumprimento antes de a operação travar.',
      [
        { value: `${App.tasks.length ? Math.round((onTrack / App.tasks.length) * 100) : 0}%`, label: 'Dentro do combinado', color: 'var(--green)' },
        { value: overdue, label: 'Fora do SLA', color: 'var(--red)' },
        { value: App.tasks.filter(t => getUrgency(t) === 'hoje').length, label: 'Vence hoje', color: 'var(--yellow)' }
      ],
      [
        { label: 'Departamento crítico', value: rows[0]?.dep?.nome || '—', color: 'var(--red)' },
        { label: 'Melhor taxa de saúde', value: rows.slice().sort((a,b)=>b.metrics.slaHealth-a.metrics.slaHealth)[0]?.dep?.nome || '—', color: 'var(--green)' },
        { label: 'Meta de leitura', value: 'Prazo + status por equipe' }
      ]
    );
    container.innerHTML = `
      ${hero}
      <div class="panel-grid">
        <div class="panel-card">
          <div class="panel-card-header">
            <div>
              <div class="panel-card-title">Mapa de SLA por departamento</div>
              <div class="panel-card-subtitle">Saúde, atraso e pressão operacional</div>
            </div>
          </div>
          ${rows.length ? rows.map(row => `
            <div class="metric-row">
              <div style="flex:1">
                <div class="metric-name">${escHtml(row.dep.nome)}</div>
                <div class="panel-card-subtitle">Meta ${escHtml(row.dep.sla_dias || '3')} dias • ${row.metrics.tasks.length} tarefas</div>
                <div class="progress-track" style="margin-top:10px"><div class="progress-fill" style="width:${row.metrics.slaHealth}%"></div></div>
              </div>
              <div style="text-align:right;min-width:72px">
                <div class="metric-value" style="color:${getStatusTone(row.metrics.slaHealth)}">${row.metrics.slaHealth}%</div>
                <div class="panel-card-subtitle">${row.metrics.atrasadas} atrasadas</div>
              </div>
            </div>
          `).join('') : '<div class="empty-col">Cadastre departamentos para acompanhar SLA</div>'}
        </div>
        <div class="panel-stack">
          <div class="panel-card">
            <div class="panel-card-title">Leituras rápidas</div>
            <div class="metric-row"><span class="metric-name">Departamentos monitorados</span><span class="metric-value">${App.departments.length}</span></div>
            <div class="metric-row"><span class="metric-name">Tarefas dentro do prazo</span><span class="metric-value" style="color:var(--green)">${onTrack}</span></div>
            <div class="metric-row"><span class="metric-name">Tarefas fora do SLA</span><span class="metric-value" style="color:var(--red)">${overdue}</span></div>
            <div class="metric-row"><span class="metric-name">Prazo vence hoje</span><span class="metric-value" style="color:var(--yellow)">${App.tasks.filter(t => getUrgency(t) === 'hoje').length}</span></div>
          </div>
          <div class="panel-card">
            <div class="panel-card-title">Distribuição por status</div>
            <div class="metric-row"><span class="metric-name">Não iniciado</span><span class="metric-value">${App.tasks.filter(t => normalizeTaskStatus(t.status) === 'Não iniciado').length}</span></div>
            <div class="metric-row"><span class="metric-name">Em andamento</span><span class="metric-value">${App.tasks.filter(t => normalizeTaskStatus(t.status) === 'Em andamento').length}</span></div>
            <div class="metric-row"><span class="metric-name">Em pausa</span><span class="metric-value">${App.tasks.filter(t => normalizeTaskStatus(t.status) === 'Em pausa').length}</span></div>
            <div class="metric-row"><span class="metric-name">Finalizado</span><span class="metric-value" style="color:var(--green)">${App.tasks.filter(t => isFinishedStatus(t.status)).length}</span></div>
            <div class="table-note">Leitura baseada no prazo de conclusão da tarefa e na estrutura atual de departamentos.</div>
          </div>
        </div>
      </div>
    `;
  };

  const renderIndicators = () => {
    const container = document.getElementById('board-container');
    const scopedTasks = App.indicatorFocus
      ? App.tasks.filter(t => t.responsavel === App.indicatorFocus)
      : App.tasks.slice();
      
    const responsaveisMap = scopedTasks.reduce((acc, t) => {
      if (!t.responsavel) return acc;
      if (!acc[t.responsavel]) acc[t.responsavel] = { total: 0, concluidas: 0, atrasadas: 0 };
      acc[t.responsavel].total++;
      if (isFinishedStatus(t.status)) acc[t.responsavel].concluidas++;
      if (getUrgency(t) === 'atrasado') acc[t.responsavel].atrasadas++;
      return acc;
    }, {});
    const topResponsaveis = Object.entries(responsaveisMap)
      .map(([nome, m]) => ({ nome, total: m.total, concluidas: m.concluidas, atrasadas: m.atrasadas, kpi: m.total ? Math.round((m.concluidas / m.total) * 100) : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    const equipesMap = scopedTasks.reduce((acc, t) => {
      if (!t.equipe) return acc;
      if (!acc[t.equipe]) acc[t.equipe] = { total: 0, atrasadas: 0, andamento: 0, finalizado: 0 };
      acc[t.equipe].total++;
      if (getUrgency(t) === 'atrasado') acc[t.equipe].atrasadas++;
      if (normalizeTaskStatus(t.status) === 'Em andamento') acc[t.equipe].andamento++;
      if (isFinishedStatus(t.status)) acc[t.equipe].finalizado++;
      return acc;
    }, {});
    const topEquipes = Object.entries(equipesMap)
      .map(([nome, m]) => ({ nome, ...m }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
    const bestKpi = topResponsaveis.slice().sort((a,b)=>b.kpi-a.kpi)[0];
    const hero = renderExecutiveHero(
      App.indicatorFocus ? `KPIs de ${escHtml(App.indicatorFocus)}.` : 'KPIs individuais e operacionais.',
      App.indicatorFocus ? 'Foco individual aplicado apenas dentro desta aba. Ao sair dela, o filtro é limpo automaticamente.' : 'Indicadores desenhados para leitura rápida: performance individual, concentração de demanda por departamento e distribuição real dos status da operação.',
      [
        { value: topResponsaveis.length, label: 'Responsáveis monitorados', color: 'var(--accent)' },
        { value: bestKpi ? `${bestKpi.kpi}%` : '0%', label: 'Melhor KPI individual', color: 'var(--green)' },
        { value: scopedTasks.filter(t => normalizeTaskStatus(t.status) === 'Em andamento').length, label: 'Tarefas em execução', color: 'var(--yellow)' }
      ],
      [
        { label: 'Destaque individual', value: bestKpi?.nome || '—', color: 'var(--green)' },
        { label: 'Equipe mais carregada', value: topEquipes[0]?.nome || '—' },
        { label: 'Atraso individual máximo', value: topResponsaveis.slice().sort((a,b)=>b.atrasadas-a.atrasadas)[0]?.nome || '—', color: 'var(--red)' }
      ]
    );

    container.innerHTML = `
      ${hero}
      <div class="panel-grid">
        <div class="panel-card">
          <div class="panel-card-header">
            <div>
              <div class="panel-card-title">KPI individual</div>
              <div class="panel-card-subtitle">Concluídas, carteira e risco pessoal</div>
            </div>
          </div>
          ${topResponsaveis.length ? topResponsaveis.map(item => `
            <div class="metric-row">
              <div style="flex:1">
                <div class="metric-name">${escHtml(item.nome)}</div>
                <div class="panel-card-subtitle">${item.concluidas} concluidas • ${item.atrasadas} atrasadas • ${item.total} no total</div>
                <div class="progress-track" style="margin-top:10px"><div class="progress-fill" style="width:${item.kpi}%"></div></div>
              </div>
              <div style="text-align:right;min-width:68px">
                <div class="metric-value" style="color:${getStatusTone(item.kpi)}">${item.kpi}%</div>
                <div class="panel-card-subtitle">KPI</div>
              </div>
            </div>
          `).join('') : '<div class="empty-col">Sem dados para indicadores</div>'}
        </div>
        <div class="panel-stack">
          <div class="panel-card">
            <div class="panel-card-title">Tarefas por departamento</div>
            ${topEquipes.length ? topEquipes.map(item => `
              <div class="metric-row">
                <div>
                  <div class="metric-name">${escHtml(item.nome)}</div>
                  <div class="panel-card-subtitle">${item.finalizado} finalizadas • ${item.andamento} em andamento • ${item.atrasadas} atrasadas</div>
                </div>
                <div class="metric-value">${item.total}</div>
              </div>
            `).join('') : '<div class="empty-col">Sem dados para indicadores</div>'}
          </div>
          <div class="panel-card">
            <div class="panel-card-title">Status gerais da operação</div>
            <div class="metric-row"><span class="metric-name">Não iniciado</span><span class="metric-value">${App.tasks.filter(t => normalizeTaskStatus(t.status) === 'Não iniciado').length}</span></div>
            <div class="metric-row"><span class="metric-name">Em andamento</span><span class="metric-value" style="color:var(--yellow)">${App.tasks.filter(t => normalizeTaskStatus(t.status) === 'Em andamento').length}</span></div>
            <div class="metric-row"><span class="metric-name">Em pausa</span><span class="metric-value" style="color:var(--purple)">${App.tasks.filter(t => normalizeTaskStatus(t.status) === 'Em pausa').length}</span></div>
            <div class="metric-row"><span class="metric-name">Finalizado</span><span class="metric-value" style="color:var(--green)">${App.tasks.filter(t => isFinishedStatus(t.status)).length}</span></div>
          </div>
        </div>
      </div>
    `;
  };

  const onDragStart = (e, id) => {
    App.draggedId = id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => {
      document.querySelector(`.task-card[data-id="${id}"]`)?.classList.add('dragging');
    }, 0);
  };
  const onDragEnd = (el) => { el.classList.remove('dragging'); App.draggedId = null; };
  const onDragOver = (e, col) => { e.preventDefault(); col.classList.add('drag-over'); };
  const onDragLeave = (e, col) => { col.classList.remove('drag-over'); };
  
  const onDrop = async (e, status) => {
    e.preventDefault();
    document.querySelectorAll('.kanban-col').forEach(c => c.classList.remove('drag-over'));
    if (!canEditTask()) {
      toast('Seu perfil pode comentar, mas não alterar status.', 'warning');
      App.draggedId = null;
      return;
    }
    if (!App.draggedId) return;
    const task = App.tasks.find(t => t.id === App.draggedId);
    if (!task || task.status === status) return;
    task.status = status;
    applyFilters(); renderBoard();
    toast(`Status atualizado ? ${status}`, 'success');
    apiPost({ action: 'updateStatus', id: task.id, status }, { background: true })
      .catch(() => toast('Erro ao atualizar status', 'error'));
  };

  const openPrimaryDrawer = () => {
    if (!canCreateTask() && isTaskView(App.currentView)) {
      toast('Seu perfil não pode cadastrar novas tarefas.', 'warning');
      return;
    }
    if (!canManageStructure() && (App.currentView === 'collaborators' || App.currentView === 'departments' || App.currentView === 'sla')) {
      toast('Seu perfil não pode cadastrar itens estruturais.', 'warning');
      return;
    }
    if (App.currentView === 'access' && !canManageUsers()) {
      toast('Seu perfil não pode gerenciar acessos.', 'warning');
      return;
    }
    if (App.currentView === 'collaborators') return openCollaboratorDrawer();
    if (App.currentView === 'departments' || App.currentView === 'sla') return openDepartmentDrawer();
    if (App.currentView === 'access') return openUserDrawer();
    if (App.currentView === 'indicators') return;
    openNewTaskDrawer();
  };

  const openNewTaskDrawer = () => {
    App.drawerMode = 'task';
    App.currentTask = null;
    App.currentDepartment = null;
    App.currentCollaborator = null;
    document.getElementById('drawer-title').textContent = 'Nova Tarefa';
    document.getElementById('btn-delete-task').style.display = 'none';
    renderDrawerForm(null);
    openDrawer();
  };

  const openTaskDrawer = (id) => {
    const task = App.tasks.find(t => String(t.id) === String(id));
    if (!task) return;
    if (!canEditTask() && hasRole('visitante')) {
      toast('Seu perfil • somente leitura.', 'warning');
    }
    App.drawerMode = 'task';
    App.currentTask = JSON.parse(JSON.stringify(task)); // deep copy
    App.currentDepartment = null;
    App.currentCollaborator = null;
    document.getElementById('drawer-title').textContent = 'Editar Tarefa';
    document.getElementById('btn-delete-task').style.display = '';
    renderDrawerForm(task);
    openDrawer();
  };

  const openDepartmentDrawer = (id) => {
    if (!canManageStructure()) {
      toast('Seu perfil não pode alterar departamentos.', 'warning');
      return;
    }
    App.drawerMode = 'department';
    App.currentTask = null;
    App.currentCollaborator = null;
    App.currentDepartment = id ? JSON.parse(JSON.stringify(App.departments.find(d => String(d.id) === String(id)) || null)) : null;
    document.getElementById('drawer-title').textContent = App.currentDepartment ? 'Editar Departamento' : 'Novo Departamento';
    document.getElementById('btn-delete-task').style.display = App.currentDepartment ? '' : 'none';
    renderDepartmentDrawerForm(App.currentDepartment);
    openDrawer();
  };

  const openCollaboratorDrawer = (id) => {
    if (!canManageStructure()) {
      toast('Seu perfil não pode alterar colaboradores.', 'warning');
      return;
    }
    App.drawerMode = 'collaborator';
    App.currentTask = null;
    App.currentDepartment = null;
    App.currentCollaborator = id ? JSON.parse(JSON.stringify(App.collaborators.find(c => String(c.id) === String(id)) || null)) : null;
    document.getElementById('drawer-title').textContent = App.currentCollaborator ? 'Editar Colaborador' : 'Novo Colaborador';
    document.getElementById('btn-delete-task').style.display = App.currentCollaborator ? '' : 'none';
    renderCollaboratorDrawerForm(App.currentCollaborator);
    openDrawer();
  };

  const openUserDrawer = (id) => {
    if (!canManageUsers()) {
      toast('Seu perfil não pode gerenciar acessos.', 'warning');
      return;
    }
    App.drawerMode = 'user';
    App.currentTask = null;
    App.currentDepartment = null;
    App.currentCollaborator = null;
    App.currentAccessUser = id ? JSON.parse(JSON.stringify(App.users.find(u => String(u.id) === String(id)) || null)) : null;
    document.getElementById('drawer-title').textContent = App.currentAccessUser ? 'Editar Acesso' : 'Novo Usuário';
    document.getElementById('btn-delete-task').style.display = App.currentAccessUser ? '' : 'none';
    renderUserDrawerForm(App.currentAccessUser);
    openDrawer();
  };

  const openDrawer = () => {
    updateDrawerPermissions();
    document.getElementById('drawer').classList.add('open');
    document.getElementById('drawer-overlay').classList.add('open');
  };
  const closeDrawer = () => {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawer-overlay').classList.remove('open');
    if (App.pendingComment?.timer) clearTimeout(App.pendingComment.timer);
    App.pendingComment = null;
    App.currentTask = null;
    App.currentDepartment = null;
    App.currentCollaborator = null;
    App.currentAccessUser = null;
  };

  const updateDrawerPermissions = () => {
    const saveBtn = document.querySelector('.btn-save');
    const deleteBtn = document.getElementById('btn-delete-task');
    if (!saveBtn || !deleteBtn) return;
    const canSave = App.drawerMode === 'task'
      ? ((App.currentTask && (canEditTask() || canCommentTask())) || (!App.currentTask && canCreateTask()))
      : App.drawerMode === 'user'
        ? canManageUsers()
        : canManageStructure();
    const canDelete = App.drawerMode === 'task'
      ? canDeleteTask()
      : App.drawerMode === 'user'
        ? canManageUsers()
        : canManageStructure();
    saveBtn.style.display = canSave ? '' : 'none';
    if (deleteBtn.style.display !== 'none') deleteBtn.style.display = canDelete ? '' : 'none';
  };

  const setDrawerTab = (tab) => {
    App.drawerTab = tab;
    document.querySelectorAll('.drawer-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.drawer-tab-panel').forEach(panel => {
      panel.classList.toggle('view-hidden', panel.dataset.tab !== tab);
    });
    renderIcons();
  };

  const getDepartmentNames = () => [...new Set(App.departments.map(d => d.nome).filter(Boolean))].sort();

  const getCollaboratorOptions = (team) => App.collaborators
      .filter(c => !team || !c.departamento || c.departamento === team)
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  const getTaskResponsibleOptions = (team, currentResponsible) => {
    const options = getCollaboratorOptions(team).slice();
    if (currentResponsible && !options.some(item => item.nome === currentResponsible)) {
      options.unshift({ nome: currentResponsible, cargo: 'Sem cadastro' });
    }
    return options;
  };

  const formatTaskDate = (value, fallback = 'Sem prazo') => {
    if (!value) return fallback;
    const parsed = parseLocalDate(value);
    if (!parsed) return fallback;
    return parsed.toLocaleDateString('pt-BR');
  };

  const formatDateInputValue = (value) => {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    const parsed = parseLocalDate(value);
    if (!parsed) return '';
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const normalizeDueDateInput = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (brMatch) {
      const [, day, month, year] = brMatch;
      const iso = `${year}-${month}-${day}`;
      const parsed = new Date(`${iso}T00:00:00`);
      if (!isNaN(parsed.getTime())) return iso;
      return null;
    }
    const parsed = parseLocalDate(raw);
    if (!parsed) return null;
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const applyDueDateMask = (value) => {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  };

  const renderDrawerForm = (task) => {
    const t = task || {};
    const readOnlyTask = !!t.id && !canEditTask();
    const subs = parseJsonSafe(t.subtarefas);
    const comments = parseJsonSafe(t.comentarios);
    const { links, cleaned } = extractBitrixLinks(t.observacoes);
    const currentTab = t.id ? (App.drawerTab || 'overview') : 'overview';
    const pendingCommentText = (App.pendingComment && t.id && App.pendingComment.taskId === t.id)
      ? App.pendingComment.text
      : '';

    const selectedStatusValue = t.status || 'Não iniciado';
    const statusOpts = ['Não iniciado','Em andamento','Finalizado','Finalizado no prazo','Finalizado em atraso','Em pausa']
      .map(s => `<button class="status-opt${selectedStatusValue===s?' selected':''}" data-val="${s}" ${readOnlyTask ? 'disabled' : ''} onclick="selectStatus(this)">${s}</button>`).join('');

    const equipes = getDepartmentNames();
    const responsaveis = getTaskResponsibleOptions(t.equipe, t.responsavel);

    const prog = subs.length ? progressInfo(t) : null;
    const prazoFormatado = formatTaskDate(t.prazo_conclusao);
    const prazoInputValue = formatTaskDate(t.prazo_conclusao, '');
    const prazoNativeValue = formatDateInputValue(t.prazo_conclusao);
    const dataCriacaoFormatada = t.data_criacao ? new Date(t.data_criacao).toLocaleString('pt-BR') : 'Será registrada ao salvar';
    const comentarioCount = comments.length;

    document.getElementById('drawer-body').innerHTML = `
      <div class="drawer-tabs">
        <button class="drawer-tab${currentTab === 'overview' ? ' active' : ''}" data-tab="overview" onclick="setDrawerTab('overview')"><i data-lucide="layout-template" class="icon icon-sm"></i>Visão geral</button>
        <button class="drawer-tab${currentTab === 'subtasks' ? ' active' : ''}" data-tab="subtasks" onclick="setDrawerTab('subtasks')"><i data-lucide="list-todo" class="icon icon-sm"></i>Subtarefas</button>
        <button class="drawer-tab${currentTab === 'comments' ? ' active' : ''}" data-tab="comments" onclick="setDrawerTab('comments')"><i data-lucide="messages-square" class="icon icon-sm"></i>Comentários</button>
      </div>

      <div class="drawer-tab-panel${currentTab === 'overview' ? '' : ' view-hidden'}" data-tab="overview">
        ${t.id ? `
          <div class="drawer-overview">
            <div class="drawer-pill">
              <div class="drawer-pill-label">Criação</div>
              <div class="drawer-pill-value">${escHtml(dataCriacaoFormatada)}</div>
            </div>
            <div class="drawer-pill">
              <div class="drawer-pill-label">Prazo</div>
              <div class="drawer-pill-value">${escHtml(prazoFormatado)}</div>
            </div>
            <div class="drawer-pill">
              <div class="drawer-pill-label">Comentários</div>
              <div class="drawer-pill-value">${comentarioCount}</div>
            </div>
          </div>
        ` : ''}
        <div class="form-group">
          <label class="form-label">Objetivo / Título</label>
          <textarea class="form-textarea" id="f-objetivo" rows="3" ${readOnlyTask ? 'readonly' : ''}>${escHtml(t.objetivo||'')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Equipe</label>
            <select class="form-select" id="f-equipe" ${readOnlyTask ? 'disabled' : ''}>
              <option value="">Selecione um departamento</option>
              ${equipes.map(e => `<option value="${e}"${t.equipe===e?' selected':''}>${e}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Responsável</label>
            <select class="form-select" id="f-responsavel" ${readOnlyTask ? 'disabled' : ''}>
              <option value="">Selecione um colaborador</option>
              ${responsaveis.map(r => `<option value="${escHtml(r.nome)}"${t.responsavel===r.nome?' selected':''}>${escHtml(r.nome)}${r.cargo ? ' • ' + escHtml(r.cargo) : ''}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Prazo</label>
            <div class="date-input-shell">
              <input class="form-input" id="f-prazo" type="text" inputmode="numeric" placeholder="dd/mm/aaaa" value="${prazoInputValue}" ${readOnlyTask ? 'disabled' : ''} />
              <button class="btn-icon date-picker-btn" type="button" tabindex="-1" aria-hidden="true"><i data-lucide="calendar-days" class="icon"></i></button>
              <input class="date-native-input" id="f-prazo-native" type="date" value="${prazoNativeValue}" ${readOnlyTask ? 'disabled' : ''} />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Status</label>
            <div class="status-selector" id="status-selector">${statusOpts}</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Observações</label>
          <textarea class="form-textarea" id="f-obs" placeholder="Notas, links do Bitrix24..." ${readOnlyTask ? 'readonly' : ''}>${escHtml(cleaned)}</textarea>
          ${links.length ? `<div class="obs-links">${links.map((l,i) => `<a class="bitrix-btn" href="${l}" target="_blank"><i data-lucide="external-link" class="icon icon-sm"></i>Tarefa Bitrix #${i+1}</a>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="drawer-tab-panel${currentTab === 'subtasks' ? '' : ' view-hidden'}" data-tab="subtasks">
        <div class="subtasks-section">
          <div class="subtasks-header">
            <span class="subtasks-title">Subtarefas</span>
            ${prog ? `<span class="subtask-progress-mini">${prog.done}/${prog.total} - ${prog.pct}%</span>` : ''}
          </div>
          <div class="subtask-list" id="subtask-list">
            ${subs.map((s, i) => renderSubtaskItem(s, i, readOnlyTask)).join('')}
          </div>
          ${readOnlyTask ? '' : `<button class="btn-add-subtask" onclick="addSubtask()"><i data-lucide="plus" class="icon icon-sm"></i>Adicionar subtarefa</button>`}
        </div>
      </div>

      <div class="drawer-tab-panel${currentTab === 'comments' ? '' : ' view-hidden'}" data-tab="comments">
        <div class="subtasks-section">
          <div class="subtasks-header">
            <span class="subtasks-title">Comentários</span>
            ${comments.length ? `<span class="subtask-progress-mini">${comments.length} nota${comments.length > 1 ? 's' : ''}</span>` : ''}
          </div>
          <div class="subtask-list">
            ${comments.length ? comments.map((comment, index) => `
              <div class="subtask-item done" style="display:block">
                <div class="management-top" style="margin-bottom:8px">
                  <div class="management-title" style="font-size:0.78rem">${escHtml(comment.autor || 'Sistema')}</div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <div class="management-subtitle">${new Date(comment.data_criacao || Date.now()).toLocaleString('pt-BR')}</div>
                    ${canDeleteComment(comment) ? `<button class="btn-tiny" type="button" onclick="deleteTaskComment('${escAttr(t.id)}','${escAttr(comment.id || '')}',${index})">Excluir</button>` : ''}
                  </div>
                </div>
                <div class="management-subtitle" style="color:var(--text-primary)">${escHtml(comment.texto || '')}</div>
              </div>
            `).join('') : `<div class="empty-col" style="padding:18px 12px">Nenhum comentário registrado</div>`}
          </div>
          ${canCommentTask() && t.id ? `
            <div class="management-subtitle" style="margin:4px 0 2px">O comentário será salvo junto com o botão principal da tarefa.</div>
            <textarea class="form-textarea" id="task-comment-input" rows="3" placeholder="Adicione um comentário útil sobre andamento, risco, decisão ou contexto" oninput="syncPendingComment(this.value)">${escHtml(pendingCommentText || '')}</textarea>
          ` : ''}
        </div>
      </div>
    `;

    refreshSubtaskEvents();
    document.getElementById('f-equipe')?.addEventListener('change', onTaskDepartmentChange);
    document.getElementById('f-prazo')?.addEventListener('input', syncTaskDueDateTextInput);
    document.getElementById('f-prazo-native')?.addEventListener('input', syncTaskDueDateNativeInput);
    document.getElementById('f-prazo-native')?.addEventListener('change', syncTaskDueDateNativeInput);
    setDrawerTab(currentTab);
    renderIcons();
  };

  const renderDepartmentDrawerForm = (dep) => {
    const d = dep || {};
    document.getElementById('drawer-body').innerHTML = `
      <div class="form-group">
        <label class="form-label">Nome do Departamento</label>
        <input class="form-input" id="d-nome" type="text" value="${escHtml(d.nome || '')}" placeholder="Ex.: Operacional" />
      </div>
      <div class="form-group">
        <label class="form-label">Descrição</label>
        <textarea class="form-textarea" id="d-descricao" rows="4">${escHtml(d.descricao || '')}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">SLA padrão em dias</label>
          <input class="form-input" id="d-sla" type="number" min="1" value="${escHtml(d.sla_dias || '3')}" />
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="d-ativo">
            <option value="true"${String(d.ativo || 'true') !== 'false' ? ' selected' : ''}>Ativo</option>
            <option value="false"${String(d.ativo || 'true') === 'false' ? ' selected' : ''}>Inativo</option>
          </select>
        </div>
      </div>
    `;
  };

  const renderCollaboratorDrawerForm = (collab) => {
    const c = collab || {};
    const departments = getDepartmentNames();
    document.getElementById('drawer-body').innerHTML = `
      <div class="form-group">
        <label class="form-label">Nome</label>
        <input class="form-input" id="c-nome" type="text" value="${escHtml(c.nome || '')}" placeholder="Nome completo" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">E-mail</label>
          <input class="form-input" id="c-email" type="email" value="${escHtml(c.email || '')}" placeholder="email@empresa.com" />
        </div>
        <div class="form-group">
          <label class="form-label">Cargo</label>
          <input class="form-input" id="c-cargo" type="text" value="${escHtml(c.cargo || '')}" placeholder="Ex.: Gerente" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Departamento</label>
          <select class="form-select" id="c-departamento">
            <option value="">Selecione um departamento</option>
            ${departments.map(dep => `<option value="${escHtml(dep)}"${c.departamento===dep?' selected':''}>${escHtml(dep)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="c-status">
            <option value="Ativo"${(c.status || 'Ativo') === 'Ativo' ? ' selected' : ''}>Ativo</option>
            <option value="Inativo"${c.status === 'Inativo' ? ' selected' : ''}>Inativo</option>
          </select>
        </div>
      </div>
    `;
  };

  const renderUserDrawerForm = (user) => {
    const u = user || {};
    document.getElementById('drawer-body').innerHTML = `
      <div class="form-group">
        <label class="form-label">Nome</label>
        <input class="form-input" id="u-nome" type="text" value="${escHtml(u.nome || '')}" placeholder="Nome do usuário" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">E-mail</label>
          <input class="form-input" id="u-email" type="email" value="${escHtml(u.email || '')}" placeholder="email@empresa.com" ${u.id ? 'disabled' : ''} />
        </div>
        <div class="form-group">
          <label class="form-label">Permissão</label>
          <select class="form-select" id="u-role">
            <option value="visitante"${u.papel==='visitante'?' selected':''}>Visitante</option>
            <option value="analista"${u.papel==='analista'?' selected':''}>Analista</option>
            <option value="administrador"${u.papel==='administrador'?' selected':''}>Administrador</option>
            <option value="dev"${u.papel==='dev'?' selected':''}>Dev</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="u-active">
            <option value="true"${String(u.ativo || 'true') === 'true' ? ' selected' : ''}>Ativo</option>
            <option value="false"${String(u.ativo || 'true') === 'false' ? ' selected' : ''}>Inativo</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">E-mail verificado</label>
          <select class="form-select" id="u-verified">
            <option value="true"${String(u.email_verificado || 'false') === 'true' ? ' selected' : ''}>Sim</option>
            <option value="false"${String(u.email_verificado || 'false') !== 'true' ? ' selected' : ''}>Não</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${u.id ? 'Nova senha opcional' : 'Senha inicial'}</label>
        <input class="form-input" id="u-password" type="password" placeholder="${u.id ? 'Preencha só se quiser trocar' : 'Senha inicial do usuário'}" />
      </div>
    `;
  };

  const onTaskDepartmentChange = (e) => {
    const selectedTeam = e.target.value;
    const responsavelEl = document.getElementById('f-responsavel');
    if (!responsavelEl) return;
    const currentValue = responsavelEl.value;
    const options = getTaskResponsibleOptions(selectedTeam, currentValue);
    responsavelEl.innerHTML = `<option value="">Selecione um colaborador</option>${
      options.map(r => `<option value="${escHtml(r.nome)}"${currentValue===r.nome?' selected':''}>${escHtml(r.nome)}${r.cargo ? ' • ' + escHtml(r.cargo) : ''}</option>`).join('')
    }`;
  };

  const syncTaskDueDateTextInput = (event) => {
    const input = event?.target || document.getElementById('f-prazo');
    const nativeInput = document.getElementById('f-prazo-native');
    if (!input) return;
    const masked = applyDueDateMask(input.value);
    input.value = masked;
    if (!nativeInput) return;
    const normalized = normalizeDueDateInput(masked);
    nativeInput.value = normalized && normalized !== null ? normalized : '';
  };

  const syncTaskDueDateNativeInput = (event) => {
    const nativeInput = event?.target || document.getElementById('f-prazo-native');
    const textInput = document.getElementById('f-prazo');
    if (!nativeInput || !textInput) return;
    textInput.value = formatTaskDate(nativeInput.value, '');
  };

  const renderSubtaskItem = (s, i, readOnly = false) => {
    return `<div class="subtask-item${s.concluido?' done':''}${readOnly?' read-only':''}" data-si="${i}">
      <div class="subtask-checkbox${readOnly?' read-only':''}" ${readOnly ? '' : `onclick="toggleSubtask(${i})"`}>${s.concluido?'?':''}</div>
      <textarea class="subtask-text" rows="1" ${readOnly ? 'readonly' : ''} oninput="autoResizeTA(this);updateSubtaskText(${i},this.value)">${escHtml(s.texto)}</textarea>
      ${readOnly ? '' : `<button class="subtask-delete" onclick="deleteSubtask(${i})" title="Remover">?</button>`}
    </div>`;
  };

  const getCurrentSubtasks = () => {
    const items = document.querySelectorAll('#subtask-list .subtask-item');
    return Array.from(items).map(el => ({
      id: parseInt(el.dataset.si) + 1,
      texto: el.querySelector('.subtask-text')?.value || '',
      concluido: el.classList.contains('done')
    }));
  };

  const refreshSubtaskEvents = () => {
    document.querySelectorAll('.subtask-text').forEach(ta => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });
  };

  const addSubtask = () => {
    const subs = getCurrentSubtasks();
    const newSub = { id: subs.length + 1, texto: '', concluido: false };
    subs.push(newSub);
    const list = document.getElementById('subtask-list');
    const div = document.createElement('div');
    div.innerHTML = renderSubtaskItem(newSub, subs.length - 1);
    list.appendChild(div.firstElementChild);
    const ta = list.lastElementChild.querySelector('.subtask-text');
    ta.focus();
    refreshSubtaskEvents();
  };

  const toggleSubtask = (i) => {
    const el = document.querySelector(`#subtask-list .subtask-item[data-si="${i}"]`);
    if (!el) return;
    el.classList.toggle('done');
    const cb = el.querySelector('.subtask-checkbox');
    cb.textContent = el.classList.contains('done') ? '?' : '';
  };

  const updateSubtaskText = (i, val) => {};

  const deleteSubtask = (i) => {
    const el = document.querySelector(`#subtask-list .subtask-item[data-si="${i}"]`);
    if (el) el.remove();
    document.querySelectorAll('#subtask-list .subtask-item').forEach((el, j) => {
      el.dataset.si = j;
      el.querySelector('.subtask-checkbox').setAttribute('onclick', `toggleSubtask(${j})`);
      el.querySelector('.subtask-delete').setAttribute('onclick', `deleteSubtask(${j})`);
      el.querySelector('.subtask-text').setAttribute('oninput', `autoResizeTA(this);updateSubtaskText(${j},this.value)`);
    });
  };

  const selectStatus = (btn) => {
    document.querySelectorAll('#status-selector .status-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  };

  const autoResizeTA = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };

  const updateUIAndSync = (message, apiAction, payload, tempIdToReplace = null, replaceList = null) => {
    closeDrawer();
    syncAppChrome();
    persistBootstrapCache({
      tasks: App.tasks,
      departments: App.departments,
      collaborators: App.collaborators,
      users: App.users,
      currentUser: App.currentUser
    });
    toast(message, 'success');
    
    apiPost({ action: apiAction, payload }, { background: true })
      .then(savedEntity => {
        const targetList = replaceList || App.tasks;
        if (savedEntity?.id && tempIdToReplace && targetList) {
          const i = targetList.findIndex(item => item.id === tempIdToReplace);
          if (i !== -1) targetList[i] = { ...targetList[i], ...savedEntity };
        } else if (savedEntity?.id && targetList) {
          const i = targetList.findIndex(item => item.id === savedEntity.id);
          if (i !== -1) targetList[i] = { ...targetList[i], ...savedEntity };
        }
        syncAppChrome();
        persistBootstrapCache({
          tasks: App.tasks,
          departments: App.departments,
          collaborators: App.collaborators,
          users: App.users,
          currentUser: App.currentUser
        });
      })
      .catch(() => toast('Aviso: sync falhou. Dado salvo localmente.', 'warning'));
  };

  const syncPendingComment = (text) => {
    if (!App.currentTask?.id) return;
    const normalized = String(text || '');
    if (!normalized.trim()) {
      App.pendingComment = null;
      return;
    }
    App.pendingComment = {
      taskId: App.currentTask.id,
      text: normalized
    };
  };

  const appendCommentToTask = (task, text) => {
    if (!text?.trim()) return task;
    const comments = parseJsonSafe(task.comentarios);
    comments.unshift({
      id: 'local-comment-' + Date.now(),
      autor: App.currentUser?.nome || App.currentUser?.email || 'Sistema',
      texto: text.trim(),
      data_criacao: new Date().toISOString()
    });
    return { ...task, comentarios: JSON.stringify(comments) };
  };

  const deleteTaskComment = async (taskId, commentId = '', commentIndex = -1) => {
    if (!canCommentTask()) return;
    const idx = App.tasks.findIndex(t => String(t.id) === String(taskId));
    if (idx === -1) return;

    const comments = parseJsonSafe(App.tasks[idx].comentarios);
    const target = commentId
      ? comments.find(item => String(item.id || '') === String(commentId))
      : comments[Number(commentIndex)];

    if (!target) return toast('Comentário não encontrado.', 'warning');
    if (!canDeleteComment(target)) return toast('Você não pode excluir este comentário.', 'warning');
    const confirmed = await requestConfirm({
      title: 'Excluir comentário',
      message: 'Esse comentário será removido para todos os usuários.',
      confirmLabel: 'Excluir'
    });
    if (!confirmed) return;

    const previousCommentsRaw = App.tasks[idx].comentarios;
    const nextComments = comments.filter((item, index) => (
      commentId ? String(item.id || '') !== String(commentId) : index !== Number(commentIndex)
    ));

    App.tasks[idx].comentarios = JSON.stringify(nextComments);
    if (App.currentTask?.id === App.tasks[idx].id) {
      App.currentTask = JSON.parse(JSON.stringify(App.tasks[idx]));
      App.drawerTab = 'comments';
      renderDrawerForm(App.currentTask);
    }
    if (isTaskView(App.currentView)) {
      applyFilters();
      renderStats();
      renderBoard();
    }

    try {
      const updatedTask = await apiPost({
        action: 'deleteComment',
        taskId,
        commentId,
        commentIndex
      });
      if (updatedTask?.comentarios) {
        App.tasks[idx] = { ...App.tasks[idx], ...updatedTask };
      }
      if (App.currentTask?.id === App.tasks[idx].id) {
        App.currentTask = JSON.parse(JSON.stringify(App.tasks[idx]));
        App.drawerTab = 'comments';
        renderDrawerForm(App.currentTask);
      }
      persistBootstrapCache({
        tasks: App.tasks,
        departments: App.departments,
        collaborators: App.collaborators,
        users: App.users,
        currentUser: App.currentUser
      });
      toast('Comentário excluído.', 'success', 1800);
    } catch (e) {
      App.tasks[idx].comentarios = previousCommentsRaw;
      if (App.currentTask?.id === App.tasks[idx].id) {
        App.currentTask = JSON.parse(JSON.stringify(App.tasks[idx]));
        App.drawerTab = 'comments';
        renderDrawerForm(App.currentTask);
      }
      toast('Falha ao excluir comentário: ' + e.message, 'error');
    }
  };

  const saveCurrentEntity = async () => {
    if (App.drawerMode === 'user') return saveUser();
    if (App.drawerMode === 'department') return saveDepartment();
    if (App.drawerMode === 'collaborator') return saveCollaborator();
    return saveTask();
  };

  const saveTask = async () => {
    const objetivo    = document.getElementById('f-objetivo')?.value.trim();
    const equipe      = document.getElementById('f-equipe')?.value;
    const responsavel = document.getElementById('f-responsavel')?.value.trim();
    const prazoRaw    = document.getElementById('f-prazo')?.value;
    const obs         = document.getElementById('f-obs')?.value.trim();
    const statusEl    = document.querySelector('#status-selector .status-opt.selected');
    const status      = statusEl?.dataset.val || 'Não iniciado';
    const subtarefas  = JSON.stringify(getCurrentSubtasks());
    const commentText = document.getElementById('task-comment-input')?.value.trim() || '';
    const prazo       = normalizeDueDateInput(prazoRaw);

    if (!objetivo) return toast('Preencha o objetivo da tarefa', 'warning');
    if (prazo === null) return toast('Informe o prazo em formato valido, como 20/04/2026.', 'warning');
    if (!App.currentTask && !canCreateTask()) return toast('Seu perfil não pode criar tarefas.', 'warning');
    if (App.currentTask && !canEditTask() && !commentText) return toast('Seu perfil pode comentar, mas não editar a tarefa.', 'warning');

    if (App.currentTask && !canEditTask()) {
      const idx = App.tasks.findIndex(t => t.id === App.currentTask.id);
      if (idx === -1) return;
      try {
        const updatedTask = await apiPost({
          action: 'addComment',
          taskId: App.currentTask.id,
          author: App.currentUser?.nome || App.currentUser?.email || 'Sistema',
          text: commentText
        });
        if (updatedTask) {
          App.tasks[idx] = { ...App.tasks[idx], ...updatedTask };
        } else {
          App.tasks[idx] = appendCommentToTask(App.tasks[idx], commentText);
        }
        App.pendingComment = null;
        closeDrawer();
        syncAppChrome();
        persistBootstrapCache({
          tasks: App.tasks,
          departments: App.departments,
          collaborators: App.collaborators,
          users: App.users,
          currentUser: App.currentUser
        });
        toast('Comentário salvo com sucesso.', 'success', 1800);
      } catch (e) {
        toast('Falha ao salvar comentário: ' + e.message, 'error');
      }
      return;
    }
    
    const baseTask = App.currentTask ? { ...App.currentTask } : { comentarios: '[]' };
    const taskWithComment = appendCommentToTask(baseTask, commentText);
    const payload = { objetivo, equipe, responsavel, prazo_conclusao: prazo, status, observacoes: obs, subtarefas, comentarios: taskWithComment.comentarios || '[]' };

    try {
      if (App.currentTask) {
        payload.id           = App.currentTask.id;
        payload.data_criacao = App.currentTask.data_criacao;
        App.pendingComment = null;
        
        updateUIAndSync('Tarefa atualizada! Sincronizando...', 'update', payload);
      } else {
        const tempId = 'local-' + Date.now();
        App.tasks.unshift({ ...payload, id: tempId, data_criacao: new Date().toISOString() });
        App.pendingComment = null;
        updateUIAndSync('Tarefa criada! Sincronizando com planilha...', 'create', payload, tempId, App.tasks);
      }
    } catch(e) {
      toast('Erro ao salvar: ' + e.message, 'error');
    }
  };

  const saveDepartment = async () => {
    if (!canManageStructure()) return toast('Seu perfil não pode alterar departamentos.', 'warning');
    const nome = document.getElementById('d-nome')?.value.trim();
    const descricao = document.getElementById('d-descricao')?.value.trim();
    const sla_dias = document.getElementById('d-sla')?.value.trim() || '3';
    const ativo = document.getElementById('d-ativo')?.value || 'true';
    
    if (!nome) return toast('Informe o nome do departamento', 'warning');

    const payload = { nome, descricao, sla_dias, ativo };
    try {
      if (App.currentDepartment) {
        payload.id = App.currentDepartment.id;
        payload.data_criacao = App.currentDepartment.data_criacao;
        
        const idx = App.departments.findIndex(d => d.id === App.currentDepartment.id);
        if (idx !== -1) {
          const previousName = App.departments[idx].nome;
          App.departments[idx] = { ...App.currentDepartment, ...payload };
          App.tasks.forEach(t => { if (t.equipe === previousName) t.equipe = nome; });
          App.collaborators.forEach(c => { if (c.departamento === previousName) c.departamento = nome; });
        }
        updateUIAndSync('Departamento atualizado!', 'updateDepartment', payload);
      } else {
        const tempId = 'dep-' + Date.now();
        App.departments.unshift({ ...payload, id: tempId, data_criacao: new Date().toISOString() });
        updateUIAndSync('Departamento criado!', 'createDepartment', payload, tempId, App.departments);
      }
    } catch (e) {
      toast('Erro ao salvar departamento: ' + e.message, 'error');
    }
  };

  const saveCollaborator = async () => {
    if (!canManageStructure()) return toast('Seu perfil não pode alterar colaboradores.', 'warning');
    const nome = document.getElementById('c-nome')?.value.trim();
    const email = document.getElementById('c-email')?.value.trim();
    const cargo = document.getElementById('c-cargo')?.value.trim();
    const departamento = document.getElementById('c-departamento')?.value || '';
    const status = document.getElementById('c-status')?.value || 'Ativo';
    
    if (!nome) return toast('Informe o nome do colaborador', 'warning');

    const payload = { nome, email, cargo, departamento, status };
    try {
      if (App.currentCollaborator) {
        payload.id = App.currentCollaborator.id;
        payload.data_criacao = App.currentCollaborator.data_criacao;
        
        const idx = App.collaborators.findIndex(c => c.id === App.currentCollaborator.id);
        if (idx !== -1) {
          const previousName = App.collaborators[idx].nome;
          App.collaborators[idx] = { ...App.currentCollaborator, ...payload };
          App.tasks.forEach(t => { if (t.responsavel === previousName) t.responsavel = nome; });
        }
        updateUIAndSync('Colaborador atualizado!', 'updateCollaborator', payload);
      } else {
        const tempId = 'col-' + Date.now();
        App.collaborators.unshift({ ...payload, id: tempId, data_criacao: new Date().toISOString() });
        updateUIAndSync('Colaborador criado!', 'createCollaborator', payload, tempId, App.collaborators);
      }
    } catch (e) {
      toast('Erro ao salvar colaborador: ' + e.message, 'error');
    }
  };

  const saveUser = async () => {
    if (!canManageUsers()) return toast('Seu perfil não pode gerenciar acessos.', 'warning');
    const nome = document.getElementById('u-nome')?.value.trim();
    const email = document.getElementById('u-email')?.value.trim();
    const papel = document.getElementById('u-role')?.value || 'visitante';
    const ativo = document.getElementById('u-active')?.value || 'true';
    const email_verificado = document.getElementById('u-verified')?.value || 'false';
    const senha = document.getElementById('u-password')?.value || '';
    
    if (!nome) return toast('Informe o nome do usuário.', 'warning');
    if (!App.currentAccessUser && !validateCorporateEmail(email)) return toast('Informe um e-mail válido.', 'warning');
    if (!App.currentAccessUser && senha.length < 8) return toast('A senha inicial deve ter pelo menos 8 caracteres.', 'warning');
    if (App.currentAccessUser && senha && senha.length < 8) return toast('A nova senha deve ter pelo menos 8 caracteres.', 'warning');

    try {
      if (App.currentAccessUser) {
        const payload = { id: App.currentAccessUser.id, nome, papel, ativo, email_verificado };
        if (senha) payload.senha = senha;
        const updated = await apiPost({ action: 'updateUser', payload });
        const idx = App.users.findIndex(u => u.id === App.currentAccessUser.id);
        if (idx !== -1) App.users[idx] = { ...App.users[idx], ...updated };
        toast('Permissão atualizada.', 'success');
      } else {
        const payload = { nome, email, papel, ativo, email_verificado, senha };
        const created = await apiPost({ action: 'createUser', payload });
        if (created) App.users.unshift(created);
        toast('Usuário criado com sucesso.', 'success');
      }
      
      closeDrawer();
      persistBootstrapCache({
        tasks: App.tasks,
        departments: App.departments,
        collaborators: App.collaborators,
        users: App.users,
        currentUser: App.currentUser
      });
      syncAppChrome();
    } catch (e) {
      toast('Erro ao salvar acesso: ' + e.message, 'error', 5000);
    }
  };

  const deleteCurrentEntity = async () => {
    if (App.drawerMode === 'user') return deleteCurrentUser();
    if (App.drawerMode === 'department') return deleteCurrentDepartment();
    if (App.drawerMode === 'collaborator') return deleteCurrentCollaborator();
    return deleteCurrentTask();
  };

  const deleteCurrentTask = async () => {
    if (!canDeleteTask()) return toast('Seu perfil não pode excluir tarefas.', 'warning');
    if (!App.currentTask) return;
    const confirmed = await requestConfirm({
      title: 'Excluir tarefa',
      message: `A tarefa "${App.currentTask.objetivo}" será removida permanentemente.`,
      confirmLabel: 'Excluir'
    });
    if (!confirmed) return;
    
    const id = App.currentTask.id;
    App.tasks = App.tasks.filter(t => t.id !== id);
    toast('Tarefa removida', 'warning');
    closeDrawer();
    syncAppChrome();
    apiPost({ action: 'delete', id }, { background: true }).catch(() => toast('Aviso: remoção não sincronizada com planilha', 'error'));
  };

  const deleteCurrentDepartment = async () => {
    if (!canManageStructure()) return toast('Seu perfil não pode excluir departamentos.', 'warning');
    if (!App.currentDepartment) return;
    const confirmed = await requestConfirm({
      title: 'Excluir departamento',
      message: `O departamento "${App.currentDepartment.nome}" será removido permanentemente.`,
      confirmLabel: 'Excluir'
    });
    if (!confirmed) return;
    
    const hasLinks = App.tasks.some(t => t.equipe === App.currentDepartment.nome) || App.collaborators.some(c => c.departamento === App.currentDepartment.nome);
    if (hasLinks) {
      toast('Remova ou mova tarefas e colaboradores antes de excluir este departamento', 'warning', 5000);
      return;
    }
    
    const id = App.currentDepartment.id;
    App.departments = App.departments.filter(d => d.id !== id);
    closeDrawer();
    syncAppChrome();
    apiPost({ action: 'deleteDepartment', id }, { background: true }).catch(() => toast('Aviso: remoção não sincronizada com planilha', 'error'));
  };

  const deleteCurrentCollaborator = async () => {
    if (!canManageStructure()) return toast('Seu perfil não pode excluir colaboradores.', 'warning');
    if (!App.currentCollaborator) return;
    const confirmed = await requestConfirm({
      title: 'Excluir colaborador',
      message: `O colaborador "${App.currentCollaborator.nome}" será removido permanentemente.`,
      confirmLabel: 'Excluir'
    });
    if (!confirmed) return;
    
    const hasLinks = App.tasks.some(t => t.responsavel === App.currentCollaborator.nome);
    if (hasLinks) {
      toast('Existem tarefas vinculadas a este colaborador', 'warning', 5000);
      return;
    }
    
    const id = App.currentCollaborator.id;
    App.collaborators = App.collaborators.filter(c => c.id !== id);
    closeDrawer();
    syncAppChrome();
    apiPost({ action: 'deleteCollaborator', id }, { background: true }).catch(() => toast('Aviso: remoção não sincronizada com planilha', 'error'));
  };

  const deleteCurrentUser = async () => {
    if (!canManageUsers()) return toast('Seu perfil não pode gerenciar acessos.', 'warning');
    if (!App.currentAccessUser) return;
    if (String(App.currentAccessUser.id) === String(App.currentUser?.id)) {
      toast('Você não pode excluir o próprio acesso enquanto está logado.', 'warning', 4500);
      return;
    }
    const confirmed = await requestConfirm({
      title: 'Excluir acesso',
      message: `O acesso de "${App.currentAccessUser.nome || App.currentAccessUser.email}" será removido permanentemente.`,
      confirmLabel: 'Excluir'
    });
    if (!confirmed) return;

    try {
      await apiPost({ action: 'deleteUser', id: App.currentAccessUser.id });
      App.users = App.users.filter(u => String(u.id) !== String(App.currentAccessUser.id));
      closeDrawer();
      persistBootstrapCache({
        tasks: App.tasks,
        departments: App.departments,
        collaborators: App.collaborators,
        users: App.users,
        currentUser: App.currentUser
      });
      syncAppChrome();
      toast('Acesso excluído com sucesso.', 'success');
    } catch (e) {
      toast('Erro ao excluir acesso: ' + e.message, 'error', 5000);
    }
  };

  const setApiUrl = () => {};

  const toast = (msg, type = 'info', dur = 3500) => {
    const icons = { success:'check-circle-2', error:'octagon-alert', warning:'triangle-alert', info:'badge-info' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon"><i data-lucide="${icons[type]||'badge-info'}" class="icon"></i></span><span class="toast-msg">${escHtml(msg)}</span>`;
    document.getElementById('toast-container').appendChild(el);
    renderIcons();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, dur);
  };

  const escHtml = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const escAttr = (s) => escHtml(s).replace(/'/g, '&#39;');

  const DEMO_TASKS = [
    { id:'d1', data_criacao:'2026-03-15T00:00:00Z', objetivo:'Finalizar ordens de serviços de 2025', equipe:'OPERACIONAL', responsavel:'Vitória Cristina', prazo_conclusao:'2026-04-01', status:'Não iniciado', observacoes:'Tarefa #94134 link: https://souuni.bitrix24.com.br/company/personal/user/1880/tasks/task/view/94134/', subtarefas:'[{"id":1,"texto":"Levantar OS em aberto","concluido":true},{"id":2,"texto":"Validar com setor","concluido":false},{"id":3,"texto":"Fechar registros","concluido":false}]' },
    { id:'d2', data_criacao:'2026-01-20T00:00:00Z', objetivo:'Treinamento financeiro com time de suporte', equipe:'OPERACIONAL', responsavel:'Ramon Thierry', prazo_conclusao:'2026-03-23', status:'Em andamento', observacoes:'Marcar reunião com Gustavo. Trabalhando em parceria com a parametrização.', subtarefas:'[{"id":1,"texto":"Listar casos críticos","concluido":true},{"id":2,"texto":"Preparar material","concluido":true},{"id":3,"texto":"Agendar reunião","concluido":false},{"id":4,"texto":"Realizar treinamento","concluido":false}]' },
    { id:'d3', data_criacao:'2026-02-18T00:00:00Z', objetivo:'Treinamento de recadastramento app tv', equipe:'PROCESSO', responsavel:'Eliezer Godoy', prazo_conclusao:'2026-03-14', status:'Em andamento', observacoes:'Tarefa #92488 Link: https://souuni.bitrix24.com.br/company/personal/user/1880/tasks/task/view/92488/', subtarefas:'[]' },
    { id:'d4', data_criacao:'2026-01-20T00:00:00Z', objetivo:'Projeto Atendimento CS • definição de limite de reincidências', equipe:'OPERACIONAL', responsavel:'Fabiano Jean', prazo_conclusao:'2026-04-10', status:'Em pausa', observacoes:'Reunião com o Sérgio para definição do limite mensal de reincidências.', subtarefas:'[{"id":1,"texto":"Reunião com Sérgio","concluido":true},{"id":2,"texto":"Avaliar vendas fora do horário","concluido":false}]' },
    { id:'d5', data_criacao:'2025-10-27T00:00:00Z', objetivo:'Validar diagnóstico de insatisfeito e muito insatisfeito para OS comercial', equipe:'PROCESSO', responsavel:'Vitória Cristina', prazo_conclusao:'2026-03-31', status:'Em andamento', observacoes:'Tarefa #67620 - pendente. Eliezer informou que até dia 20/03 quer estar entregando a demanda. https://souuni.bitrix24.com.br/company/personal/user/1422/tasks/task/view/67620/', subtarefas:'[{"id":1,"texto":"Validar ID correto","concluido":false},{"id":2,"texto":"Criar fluxo de disparo","concluido":false},{"id":3,"texto":"Testar integração","concluido":false}]' },
    { id:'d6', data_criacao:'2026-03-12T00:00:00Z', objetivo:'Verificar produtividade por capacidade vs entrega por assunto', equipe:'OPERACIONAL', responsavel:'Paulo Henrique', prazo_conclusao:'2026-03-30', status:'Em andamento', observacoes:'Depositar ID da tarefa', subtarefas:'[]' },
    { id:'d7', data_criacao:'2026-02-03T00:00:00Z', objetivo:'Projeto agendamento matriz e filiais • modelo unificado', equipe:'OPERACIONAL', responsavel:'Fabiano Jean', prazo_conclusao:'2026-03-03', status:'Em andamento', observacoes:'Modelo de agendamento: 1 agenda na filial, 2 na matriz em regime 12x36, 1 supervisora', subtarefas:'[{"id":1,"texto":"Definir estrutura","concluido":true},{"id":2,"texto":"Contratar supervisora","concluido":false},{"id":3,"texto":"Implantar agenda","concluido":false}]' },
    { id:'d8', data_criacao:'2025-12-05T00:00:00Z', objetivo:'Promover Política de Rede Neutra', equipe:'OPERACIONAL', responsavel:'Renaldo Pires', prazo_conclusao:'2026-01-10', status:'Em andamento', observacoes:'Foi criado o modelo e falta a política, junto com o CRM do suporte.', subtarefas:'[{"id":1,"texto":"Criar modelo","concluido":true},{"id":2,"texto":"Escrever política","concluido":false},{"id":3,"texto":"Integrar CRM","concluido":false},{"id":4,"texto":"Publicar internamente","concluido":false}]' },
    { id:'d9', data_criacao:'2026-03-10T00:00:00Z', objetivo:'Organizar transmissor e CTO', equipe:'OPERACIONAL', responsavel:'Renaldo Pires', prazo_conclusao:'2026-03-20', status:'Não iniciado', observacoes:'Depositar ID da tarefa', subtarefas:'[]' },
    { id:'d10', data_criacao:'2026-03-10T00:00:00Z', objetivo:'Padronizar a VLAM 2000', equipe:'OPERACIONAL', responsavel:'Ramon Thierry', prazo_conclusao:'2026-03-10', status:'Não iniciado', observacoes:'Depositar ID da tarefa', subtarefas:'[]' },
    { id:'d11', data_criacao:'2026-03-13T00:00:00Z', objetivo:'Aviso de Falha massiva • treinar equipe N2', equipe:'OPERACIONAL', responsavel:'Ramon Thierry', prazo_conclusao:'2026-03-19', status:'Não iniciado', observacoes:'Delegar para o N2. Testar e treinar a equipe do N2 para acionar o cliente. Treinamento Elieser', subtarefas:'[{"id":1,"texto":"Definir script","concluido":false},{"id":2,"texto":"Treinar N2","concluido":false},{"id":3,"texto":"Testar acesso","concluido":false}]' },
    { id:'d12', data_criacao:'2026-02-23T00:00:00Z', objetivo:'Treinamento para aplicação de preset', equipe:'OPERACIONAL', responsavel:'Ramon Thierry', prazo_conclusao:'2026-03-30', status:'Em andamento', observacoes:'Depositar ID da tarefa', subtarefas:'[]' },
    { id:'d13', data_criacao:'2026-03-02T00:00:00Z', objetivo:'Pesquisa de satisfação • pós atendimento', equipe:'OPERACIONAL', responsavel:'Vitória Cristina', prazo_conclusao:'2026-03-20', status:'Em andamento', observacoes:'Tarefa #95342. Previsão após dia 27/03. https://souuni.bitrix24.com.br/company/personal/user/1880/tasks/task/view/95342/', subtarefas:'[{"id":1,"texto":"Criar formulário","concluido":true},{"id":2,"texto":"Disparar pesquisa","concluido":false}]' },
    { id:'d14', data_criacao:'2026-03-13T00:00:00Z', objetivo:'Teste de Migração do Número Unificado', equipe:'OPERACIONAL', responsavel:'Vitória Cristina', prazo_conclusao:'2026-03-20', status:'Em andamento', observacoes:'Vai ocorrer dia 24/03. https://souuni.bitrix24.com.br/company/personal/user/1880/tasks/task/view/98960/', subtarefas:'[{"id":1,"texto":"Preparar ambiente","concluido":false},{"id":2,"texto":"Realizar migração","concluido":false},{"id":3,"texto":"Validar número","concluido":false}]' },
    { id:'d15', data_criacao:'2026-03-09T00:00:00Z', objetivo:'Preset padrão • configuração roteadores', equipe:'OPERACIONAL', responsavel:'Paulo Henrique', prazo_conclusao:'2026-03-18', status:'Em andamento', observacoes:'https://souuni.bitrix24.com.br/company/personal/user/896/tasks/task/view/97688/', subtarefas:'[]' },
    { id:'d16', data_criacao:'2025-07-04T00:00:00Z', objetivo:'Fazer visita na filial de Ouro Preto para alinhamento comportamental', equipe:'OPERACIONAL', responsavel:'Renaldo Pires', prazo_conclusao:'2025-07-09', status:'Finalizado', observacoes:'', subtarefas:'[]' },
    { id:'d17', data_criacao:'2025-06-30T00:00:00Z', objetivo:'Indicadores de Operação do Mês de Junho', equipe:'GERENTES', responsavel:'Núbia Petsch', prazo_conclusao:'2025-07-03', status:'Finalizado', observacoes:'No início a gerente não achou necessário realizar o andamento dos indicadores no mês.', subtarefas:'[{"id":1,"texto":"Coletar dados","concluido":true},{"id":2,"texto":"Montar planilha","concluido":true},{"id":3,"texto":"Apresentar","concluido":true}]' },
    { id:'d18', data_criacao:'2025-09-09T00:00:00Z', objetivo:'Implementação do IClass • treinamento e implantação', equipe:'OPERACIONAL', responsavel:'Renaldo Pires', prazo_conclusao:'2025-10-22', status:'Finalizado', observacoes:'Dia 21/10 implantação iniciada com sucesso.', subtarefas:'[{"id":1,"texto":"Treinamento Backoffice","concluido":true},{"id":2,"texto":"Treinamento equipe técnica","concluido":true},{"id":3,"texto":"Implantação","concluido":true}]' },
  ];

  Object.assign(window, {
    addSubtask,
    applyQuickMetricFilter,
    autoResizeTA,
    clearTaskFilters,
    closeDrawer,
    deleteCurrentEntity,
    deleteSubtask,
    deleteTaskComment,
    focusCollaborator,
    loginFlow,
    logoutFlow,
    onDragLeave,
    onDragOver,
    onDrop,
    onSearch,
    openCollaboratorDrawer,
    openCollaboratorPanel,
    openDepartmentDrawer,
    openPrimaryDrawer,
    openUserDrawer,
    refreshData,
    requestPasswordResetFlow,
    resetPasswordFlow,
    saveCurrentEntity,
    sendEmailVerificationFlow,
    selectStatus,
    setApiUrl,
    setDrawerTab,
    showAuthShell,
    switchView,
    syncPendingComment,
    verifyEmailFlow,
    toggleAuthPassword,
    toggleDepartmentFilters,
    toggleLegacyOnly,
    toggleResponsibleFilters,
    toggleSidebar,
    toggleSubtask,
    toggleTheme,
    updateSubtaskText
  });

  (function init() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (App.sessionToken) performAutoRefresh();
    });
    document.getElementById('config-banner').style.display = 'none';
    try {
      applyTheme(localStorage.getItem('radar-theme') || 'dark');
    } catch (_) {
      applyTheme('dark');
    }
    try {
      applySidebarState(localStorage.getItem('radar-sidebar-collapsed') === '1');
    } catch (_) {
      applySidebarState(false);
    }
    syncPrimaryAction();
    syncViewChrome();
    try {
      App.sessionToken = localStorage.getItem('radar-session-token') || '';
      App.currentUser = JSON.parse(localStorage.getItem('radar-session-user') || 'null');
    } catch (_) {
      App.sessionToken = '';
      App.currentUser = null;
    }
    updateUserPill();
    if (App.sessionToken && App.currentUser) {
      const cached = loadBootstrapCache();
      if (cached) {
        hydrateAppData(cached);
        App.bootstrappedFromCache = true;
        syncAppChrome();
        showAppShell();
      }
      loadTasks({ useCache: false, silent: !!cached })
        .then(() => showAppShell())
        .catch(() => {
          if (!cached) showAuthShell('login');
        });
    } else {
      showAuthShell('login');
    }
    renderIcons();
  })();







