(function initSupabaseStateStore(global) {
  'use strict';

  const PAGE_SIZE = 500;
  const WRITE_CHUNK_SIZE = 100;
  const AUTOSAVE_DELAY = 2 * 60 * 1000;
  const MAX_BACKUPS = 12;

  const DOCUMENT_FIELDS = Object.freeze({
    ui_settings: 'uiSettings',
    ultra_all_inclusive: 'ultraAllInclusive',
    email_txt: 'emailTxt',
    to_mapping_hotels: 'toMappingHotels',
    cancellation_policies: 'cancellationPolicies',
    task_notes_by_date: 'taskNotesByDate',
    tasks_ui: 'tasksUi',
    section_themes: 'sectionThemes',
    attendance_form: 'attendanceFormV14'
  });

  const KNOWN_ROOT_FIELDS = new Set([
    'weeks',
    'activeWeekId',
    'toMappingsLocked',
    'tasksByDate',
    'discountReservations',
    ...Object.values(DOCUMENT_FIELDS)
  ]);

  function emitStatus(detail) {
    global.dispatchEvent(new CustomEvent('sv-cloud-status', { detail }));
  }

  function cloneJson(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function stableString(value) {
    return JSON.stringify(value === undefined ? null : value);
  }

  function chunks(items, size) {
    const result = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }
    return result;
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeDate(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }

  function entityId(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
  }

  function rowSignatures(rows, keyField) {
    const map = new Map();
    rows.forEach(row => map.set(String(row[keyField]), stableString(row)));
    return map;
  }

  function workspaceSignature(workspace) {
    if (!workspace) return null;
    return stableString({
      owner_id: workspace.owner_id,
      schema_version: Number(workspace.schema_version) || 1,
      active_week_id: workspace.active_week_id || null,
      to_mappings_locked: Boolean(workspace.to_mappings_locked),
      extra_root: asObject(workspace.extra_root)
    });
  }

  function ensureNoError(result, operation) {
    if (result && result.error) {
      const error = new Error(`${operation}: ${result.error.message || result.error}`);
      error.cause = result.error;
      throw error;
    }
    return result;
  }

  function decomposeState(rawState, ownerId) {
    const state = asObject(rawState);
    const extraRoot = {};
    Object.keys(state).forEach(key => {
      if (!KNOWN_ROOT_FIELDS.has(key)) extraRoot[key] = cloneJson(state[key]);
    });

    const documents = Object.entries(DOCUMENT_FIELDS).map(([documentKey, stateKey]) => {
      let payload = cloneJson(state[stateKey] === undefined ? {} : state[stateKey]);
      if (stateKey === 'attendanceFormV14') {
        payload = asObject(payload);
        delete payload.records;
      }
      return { owner_id: ownerId, document_key: documentKey, payload };
    });

    const weeks = asArray(state.weeks).map((week, position) => {
      const payload = cloneJson(week);
      return {
        owner_id: ownerId,
        week_id: entityId(payload && payload.id, `week-${position + 1}`),
        position,
        start_date: safeDate(payload && payload.startDate),
        end_date: safeDate(payload && payload.endDate),
        payload
      };
    });

    const tasks = [];
    Object.entries(asObject(state.tasksByDate)).forEach(([taskDate, dayTasks]) => {
      asArray(dayTasks).forEach((task, position) => {
        const payload = cloneJson(task);
        const taskId = entityId(payload && payload.id, `${taskDate}-${position + 1}`);
        tasks.push({
          owner_id: ownerId,
          task_key: `${taskDate}::${taskId}`,
          task_date: safeDate(taskDate) || taskDate,
          position,
          payload
        });
      });
    });

    const reservations = asArray(state.discountReservations).map((reservation, position) => {
      const payload = cloneJson(reservation);
      return {
        owner_id: ownerId,
        reservation_id: entityId(payload && payload.id, `reservation-${position + 1}`),
        position,
        payload
      };
    });

    const attendanceRecords = Object.entries(
      asObject(asObject(state.attendanceFormV14).records)
    ).map(([recordKey, record]) => ({
      owner_id: ownerId,
      record_key: recordKey,
      payload: cloneJson(record)
    }));

    return {
      workspace: {
        owner_id: ownerId,
        schema_version: 1,
        active_week_id: state.activeWeekId || null,
        to_mappings_locked: Boolean(state.toMappingsLocked),
        extra_root: extraRoot
      },
      documents,
      weeks,
      tasks,
      reservations,
      attendanceRecords
    };
  }

  function composeState(workspace, documents, weeks, tasks, reservations, attendanceRecords) {
    const state = {
      ...cloneJson(asObject(workspace && workspace.extra_root)),
      weeks: weeks.slice().sort((a, b) => a.position - b.position).map(row => cloneJson(row.payload)),
      activeWeekId: workspace && workspace.active_week_id ? workspace.active_week_id : null,
      toMappingsLocked: Boolean(workspace && workspace.to_mappings_locked),
      tasksByDate: {},
      discountReservations: reservations
        .slice()
        .sort((a, b) => a.position - b.position)
        .map(row => cloneJson(row.payload))
    };

    const documentMap = new Map(documents.map(row => [row.document_key, row.payload]));
    Object.entries(DOCUMENT_FIELDS).forEach(([documentKey, stateKey]) => {
      state[stateKey] = cloneJson(documentMap.has(documentKey) ? documentMap.get(documentKey) : {});
    });

    tasks
      .slice()
      .sort((a, b) => String(a.task_date).localeCompare(String(b.task_date)) || a.position - b.position)
      .forEach(row => {
        const date = String(row.task_date);
        if (!state.tasksByDate[date]) state.tasksByDate[date] = [];
        state.tasksByDate[date].push(cloneJson(row.payload));
      });

    state.attendanceFormV14 = asObject(state.attendanceFormV14);
    state.attendanceFormV14.records = {};
    attendanceRecords.forEach(row => {
      state.attendanceFormV14.records[row.record_key] = cloneJson(row.payload);
    });

    return state;
  }

  class SupabaseStateStore {
    constructor(client, user) {
      if (!client || !user || !user.id) throw new Error('Липсва активна Supabase сесия.');
      this.client = client;
      this.user = user;
      this.revision = 0;
      this.hasWorkspace = false;
      this.workspaceSignature = null;
      this.caches = Object.create(null);
      this.pendingState = null;
      this.autosaveTimer = null;
      this.writeQueue = Promise.resolve();
    }

    async fetchAll(table, columns) {
      const rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const result = ensureNoError(
          await this.client
            .from(table)
            .select(columns)
            .eq('owner_id', this.user.id)
            .range(from, from + PAGE_SIZE - 1),
          `Зареждане от ${table}`
        );
        const page = result.data || [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return rows;
    }

    async loadState() {
      emitStatus({ phase: 'loading', message: 'Зареждам защитените данни...' });

      const workspaceRequest = this.client
        .from('app_workspaces')
        .select('owner_id,schema_version,revision,active_week_id,to_mappings_locked,extra_root,updated_at')
        .eq('owner_id', this.user.id)
        .maybeSingle();

      const [workspaceResult, documents, weeks, tasks, reservations, attendanceRecords] = await Promise.all([
        workspaceRequest,
        this.fetchAll('app_documents', 'owner_id,document_key,payload'),
        this.fetchAll('app_weeks', 'owner_id,week_id,position,start_date,end_date,payload'),
        this.fetchAll('app_tasks', 'owner_id,task_key,task_date,position,payload'),
        this.fetchAll('app_discount_reservations', 'owner_id,reservation_id,position,payload'),
        this.fetchAll('app_attendance_records', 'owner_id,record_key,payload')
      ]);

      ensureNoError(workspaceResult, 'Зареждане на работното пространство');
      const workspace = workspaceResult.data || null;
      const hasData = Boolean(
        workspace || documents.length || weeks.length || tasks.length || reservations.length || attendanceRecords.length
      );

      this.hasWorkspace = Boolean(workspace);
      this.revision = Number(workspace && workspace.revision) || 0;
      this.workspaceSignature = workspaceSignature(workspace);
      this.caches.app_documents = rowSignatures(documents, 'document_key');
      this.caches.app_weeks = rowSignatures(weeks, 'week_id');
      this.caches.app_tasks = rowSignatures(tasks, 'task_key');
      this.caches.app_discount_reservations = rowSignatures(reservations, 'reservation_id');
      this.caches.app_attendance_records = rowSignatures(attendanceRecords, 'record_key');

      const state = hasData
        ? composeState(workspace || {}, documents, weeks, tasks, reservations, attendanceRecords)
        : null;

      emitStatus({
        phase: 'loaded',
        message: hasData ? 'Данните са заредени от Supabase.' : 'Профилът е празен и е готов за първия импорт.',
        updatedAt: workspace && workspace.updated_at ? workspace.updated_at : null
      });

      return { state, updatedAt: workspace && workspace.updated_at ? workspace.updated_at : null };
    }

    scheduleSave(state) {
      this.pendingState = state;
      if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
      this.autosaveTimer = setTimeout(() => {
        this.autosaveTimer = null;
        const pending = this.pendingState;
        this.pendingState = null;
        if (!pending) return;
        this.saveNow(pending).catch(error => {
          console.error('Supabase autosave failed:', error);
          emitStatus({ phase: 'error', message: error.message || String(error) });
        });
      }, AUTOSAVE_DELAY);
    }

    async assertRevision() {
      const result = ensureNoError(
        await this.client
          .from('app_workspaces')
          .select('revision')
          .eq('owner_id', this.user.id)
          .maybeSingle(),
        'Проверка за по-нова версия'
      );
      const remoteRevision = Number(result.data && result.data.revision) || 0;
      const remoteExists = Boolean(result.data);
      if (remoteExists !== this.hasWorkspace || remoteRevision !== this.revision) {
        const error = new Error('Има по-нова промяна от друго устройство. Презареди данните преди нов запис.');
        error.code = 'SV_CLOUD_CONFLICT';
        throw error;
      }
    }

    async syncCollection(table, keyField, rows) {
      const previous = this.caches[table] || new Map();
      const next = rowSignatures(rows, keyField);
      const changed = rows.filter(row => previous.get(String(row[keyField])) !== next.get(String(row[keyField])));
      const removed = [...previous.keys()].filter(key => !next.has(key));

      for (const batch of chunks(changed, WRITE_CHUNK_SIZE)) {
        ensureNoError(
          await this.client.from(table).upsert(batch, { onConflict: `owner_id,${keyField}` }),
          `Запис в ${table}`
        );
      }

      for (const batch of chunks(removed, WRITE_CHUNK_SIZE)) {
        ensureNoError(
          await this.client
            .from(table)
            .delete()
            .eq('owner_id', this.user.id)
            .in(keyField, batch),
          `Изтриване от ${table}`
        );
      }

      this.caches[table] = next;
      return changed.length + removed.length;
    }

    collectionHasChanges(table, keyField, rows) {
      const previous = this.caches[table] || new Map();
      const next = rowSignatures(rows, keyField);
      if (previous.size !== next.size) return true;
      for (const [key, signature] of next) {
        if (previous.get(key) !== signature) return true;
      }
      return false;
    }

    hasChanges(parts) {
      return (
        this.workspaceSignature !== workspaceSignature(parts.workspace) ||
        this.collectionHasChanges('app_documents', 'document_key', parts.documents) ||
        this.collectionHasChanges('app_weeks', 'week_id', parts.weeks) ||
        this.collectionHasChanges('app_tasks', 'task_key', parts.tasks) ||
        this.collectionHasChanges('app_discount_reservations', 'reservation_id', parts.reservations) ||
        this.collectionHasChanges('app_attendance_records', 'record_key', parts.attendanceRecords)
      );
    }

    saveNow(state, options = {}) {
      if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
      this.pendingState = null;

      const parts = decomposeState(state, this.user.id);
      const backupPayload = options.backup ? cloneJson(state) : null;
      const task = async () => this.writeParts(parts, { ...options, backupPayload });
      this.writeQueue = this.writeQueue.then(task, task);
      return this.writeQueue;
    }

    async writeParts(parts, options) {
      if (!options.backup && !options.force && !this.hasChanges(parts)) {
        return { ok: true, confirmed: true, via: 'supabase', phase: 'unchanged', skipped: true, changes: 0 };
      }

      emitStatus({ phase: 'saving', message: 'Записвам в Supabase...' });
      await this.assertRevision();

      let changes = 0;
      changes += await this.syncCollection('app_documents', 'document_key', parts.documents);
      changes += await this.syncCollection('app_weeks', 'week_id', parts.weeks);
      changes += await this.syncCollection('app_tasks', 'task_key', parts.tasks);
      changes += await this.syncCollection('app_discount_reservations', 'reservation_id', parts.reservations);
      changes += await this.syncCollection('app_attendance_records', 'record_key', parts.attendanceRecords);

      const nextRevision = this.revision + 1;
      const workspaceRow = { ...parts.workspace, revision: nextRevision };
      ensureNoError(
        await this.client.from('app_workspaces').upsert(workspaceRow, { onConflict: 'owner_id' }),
        'Запис на работното пространство'
      );
      this.revision = nextRevision;
      this.hasWorkspace = true;
      this.workspaceSignature = workspaceSignature(parts.workspace);

      if (options.backup && options.backupPayload) {
        await this.createBackup(options.backupPayload, options.backupLabel || 'Ръчно запазване');
      }

      const detail = {
        phase: 'saved',
        message: 'Запазено в Supabase.',
        updatedAt: new Date().toISOString(),
        revision: this.revision,
        changes
      };
      emitStatus(detail);
      return { ok: true, confirmed: true, via: 'supabase', ...detail };
    }

    async createBackup(state, label) {
      ensureNoError(
        await this.client.from('app_backups').insert({
          owner_id: this.user.id,
          label: String(label || 'Ръчно запазване').slice(0, 120),
          payload: cloneJson(state)
        }),
        'Създаване на backup'
      );

      const list = ensureNoError(
        await this.client
          .from('app_backups')
          .select('id')
          .eq('owner_id', this.user.id)
          .order('created_at', { ascending: false })
          .range(MAX_BACKUPS, MAX_BACKUPS + 100),
        'Подреждане на backup-ите'
      );
      const oldIds = (list.data || []).map(item => item.id);
      if (oldIds.length) {
        ensureNoError(
          await this.client.from('app_backups').delete().eq('owner_id', this.user.id).in('id', oldIds),
          'Почистване на стари backup-и'
        );
      }
    }

    async listBackups() {
      const result = ensureNoError(
        await this.client
          .from('app_backups')
          .select('id,label,created_at')
          .eq('owner_id', this.user.id)
          .order('created_at', { ascending: false })
          .limit(MAX_BACKUPS),
        'Зареждане на backup-и'
      );
      return result.data || [];
    }

    async getBackup(id) {
      const result = ensureNoError(
        await this.client
          .from('app_backups')
          .select('payload')
          .eq('owner_id', this.user.id)
          .eq('id', id)
          .single(),
        'Зареждане на backup'
      );
      return cloneJson(result.data && result.data.payload);
    }
  }

  global.SVStateStore = Object.freeze({
    create(client, user) {
      return new SupabaseStateStore(client, user);
    },
    decomposeState,
    composeState
  });
})(window);
