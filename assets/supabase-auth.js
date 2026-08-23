(function initSupabaseAuth() {
  'use strict';

  const APP_SCRIPTS = Object.freeze({
    desktop: [
      'assets/section-loader.js',
      'assets/algara-prices-v26-lite-data.js',
      'assets/algara-lite-calculator.js',
      'assets/desktop.js?v=20260823-supabase-1'
    ],
    mobile: [
      'assets/section-loader.js',
      'assets/algara-prices-v26-lite-data.js',
      'assets/algara-lite-calculator.js',
      'assets/mobile.js?v=20260824-sidebar-arrow-1'
    ]
  });

  const gate = document.getElementById('svLoginGate');
  const form = document.getElementById('svLoginForm');
  const usernameInput = document.getElementById('svLoginUsername');
  const passwordInput = document.getElementById('svLoginPassword');
  const passwordToggle = document.getElementById('svPasswordToggle');
  const submitButton = document.getElementById('svLoginSubmit');
  const errorBox = document.getElementById('svLoginError');
  const appShell = document.getElementById('appShell');
  const config = window.SV_SUPABASE_CONFIG || {};
  let client = null;
  let appStarted = false;
  let statusResetTimer = null;

  function renderIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons({ attrs: { 'stroke-width': 2 } });
    }
  }

  function setError(message) {
    if (errorBox) errorBox.textContent = message || '';
  }

  function setBusy(busy, label) {
    if (!submitButton) return;
    submitButton.disabled = Boolean(busy);
    submitButton.textContent = label || (busy ? 'Влизам...' : 'Вход');
  }

  function validConfig() {
    return Boolean(
      /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.url || '').trim()) &&
      String(config.publishableKey || '').trim()
    );
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.defer = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Не успях да заредя ${src}.`));
      document.body.appendChild(script);
    });
  }

  async function loadApplicationScripts() {
    const appName = document.body.dataset.svApp || 'desktop';
    const scripts = APP_SCRIPTS[appName] || APP_SCRIPTS.desktop;
    for (const src of scripts) await loadScript(src);
  }

  function installLogoutButton() {
    const header = appShell && appShell.querySelector('header');
    if (!header || header.querySelector('.sv-logout-button')) return;
    const button = document.createElement('button');
    button.className = 'sv-logout-button no-print';
    button.type = 'button';
    button.title = 'Изход';
    button.setAttribute('aria-label', 'Изход');
    button.innerHTML = '<i data-lucide="log-out" aria-hidden="true"></i>';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (window.SVCloud && typeof window.SVCloud.flush === 'function') {
          await window.SVCloud.flush();
        }
      } catch (error) {
        console.warn('Final cloud save skipped:', error);
      }
      await client.auth.signOut();
      window.location.reload();
    });
    header.appendChild(button);
    renderIcons();
  }

  function configureCloudControls() {
    const cloudBox = document.querySelector('.cloud-sync');
    if (!cloudBox) return;
    const title = cloudBox.querySelector('.cloud-sync-title h3');
    if (title) title.textContent = 'Supabase';
    const urlToggle = document.getElementById('toggleGoogleUrlBtn');
    const urlSettings = document.getElementById('googleUrlSettings');
    const testButton = document.getElementById('testGoogleSyncBtn');
    if (urlToggle) urlToggle.hidden = true;
    if (urlSettings) urlSettings.hidden = true;
    if (testButton) testButton.hidden = true;
    const loadButton = document.getElementById('loadGoogleSyncBtn');
    if (loadButton) loadButton.textContent = 'Презареди';
    const backupsTitle = cloudBox.querySelector('.google-backups-head strong');
    if (backupsTitle) backupsTitle.textContent = 'Supabase backups';
    const status = document.getElementById('googleSyncStatus');
    if (status) {
      status.textContent = 'Защитената връзка със Supabase е активна.';
      status.className = 'cloud-status ok';
    }
    const notice = document.querySelector('.sidebar .notice');
    if (notice) notice.textContent = 'Данните се зареждат и записват защитено в Supabase. Експортът остава допълнително локално копие.';
  }

  function handleCloudStatus(event) {
    const status = document.getElementById('googleSyncStatus');
    const detail = event && event.detail ? event.detail : {};
    if (!status || !detail.message) return;
    if (statusResetTimer) clearTimeout(statusResetTimer);
    status.textContent = detail.message;
    status.className = `cloud-status ${detail.phase === 'error' ? 'error' : detail.phase === 'saved' || detail.phase === 'loaded' ? 'ok' : ''}`.trim();
    if (detail.phase === 'saved') {
      statusResetTimer = setTimeout(() => {
        statusResetTimer = null;
        status.textContent = 'Supabase е свързан.';
        status.className = 'cloud-status ok';
      }, 2500);
    }
  }

  async function revealApplication(session) {
    if (appStarted) return;
    if (!session || !session.user) throw new Error('Липсва валидна сесия.');
    appStarted = true;
    setBusy(true, 'Зареждам...');
    setError('');

    try {
      const store = window.SVStateStore.create(client, session.user);
      const loaded = await store.loadState();
      window.__SV_CLOUD_INITIAL_STATE__ = loaded.state;
      window.SVCloud = {
        active: true,
        user: session.user,
        updatedAt: loaded.updatedAt,
        scheduleSave(state) {
          store.scheduleSave(state);
        },
        saveNow(state, options) {
          return store.saveNow(state, options);
        },
        async flush() {
          if (!store.pendingState) return { ok: true, skipped: true };
          return store.saveNow(store.pendingState);
        },
        listBackups() {
          return store.listBackups();
        },
        getBackup(id) {
          return store.getBackup(id);
        },
        reload() {
          window.location.reload();
        }
      };

      appShell.hidden = false;
      appShell.removeAttribute('inert');
      document.body.classList.remove('sv-auth-pending');
      document.body.classList.add('sv-authenticated');
      gate.hidden = true;
      await loadApplicationScripts();
      configureCloudControls();
      installLogoutButton();
    } catch (error) {
      appStarted = false;
      console.error('Protected app startup failed:', error);
      appShell.hidden = true;
      appShell.setAttribute('inert', '');
      document.body.classList.add('sv-auth-pending');
      document.body.classList.remove('sv-authenticated');
      gate.hidden = false;
      setBusy(false, 'Вход');
      setError('Не успях да заредя защитените данни. Провери връзката и опитай отново.');
      throw error;
    }
  }

  async function signIn(event) {
    event.preventDefault();
    setError('');

    const email = String(usernameInput.value || '').trim().toLocaleLowerCase('en-US');
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Невалидно име или парола.');
      passwordInput.value = '';
      usernameInput.focus();
      return;
    }

    setBusy(true, 'Влизам...');
    const result = await client.auth.signInWithPassword({
      email,
      password: passwordInput.value
    });

    if (result.error || !result.data || !result.data.session) {
      setBusy(false, 'Вход');
      setError('Невалидно име или парола.');
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    passwordInput.value = '';
    await revealApplication(result.data.session);
  }

  function setupPasswordToggle() {
    if (!passwordToggle || !passwordInput) return;
    passwordToggle.addEventListener('click', () => {
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      passwordToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      passwordToggle.setAttribute('aria-label', show ? 'Скрий паролата' : 'Покажи паролата');
      passwordToggle.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}" aria-hidden="true"></i>`;
      renderIcons();
      passwordInput.focus();
    });
  }

  async function boot() {
    window.addEventListener('sv-cloud-status', handleCloudStatus);
    setupPasswordToggle();
    renderIcons();

    if (!validConfig() || !window.supabase || !window.SVStateStore) {
      setBusy(false, 'Вход');
      setError('Защитената връзка още не е конфигурирана.');
      return;
    }

    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
    window.SVSupabase = client;
    form.addEventListener('submit', signIn);

    const sessionResult = await client.auth.getSession();
    if (sessionResult.error) {
      setError('Не успях да проверя сесията.');
      return;
    }
    if (sessionResult.data && sessionResult.data.session) {
      await revealApplication(sessionResult.data.session);
      return;
    }

    setBusy(false, 'Вход');
    usernameInput.focus();
  }

  boot().catch(error => console.error(error));
})();
