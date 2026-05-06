(function () {
  'use strict';

  const state = {
    subtotal: 0,
    serviceCharge: false,
    gst: false,
    splitMode: 'equal',
    people: [],
    items: [],
    editingItemId: null,
    openDropdownId: null,
    customType: 'amount',
    customAllocations: {},
    _lastResults: null
  };

  let idCounter = 0;
  function genId() { return '_' + (++idCounter); }

  // --- Currency & Rounding ---

  function toCents(dollars) { return Math.round(dollars * 100); }
  function toDollars(cents) { return cents / 100; }
  function formatSGD(dollars) { return 'S$' + dollars.toFixed(2); }

  function distributeAmount(totalCents, n) {
    if (n <= 0) return [];
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    const shares = new Array(n).fill(base);
    for (let i = shares.length - remainder; i < shares.length; i++) {
      shares[i] += 1;
    }
    return shares;
  }

  function distributeProportion(totalCents, weights) {
    const sumWeights = weights.reduce((a, b) => a + b, 0);
    if (sumWeights === 0) return weights.map(() => 0);
    let allocated = 0;
    return weights.map((w, i) => {
      if (i === weights.length - 1) return totalCents - allocated;
      const share = Math.floor(totalCents * w / sumWeights);
      allocated += share;
      return share;
    });
  }

  // --- Charge Calculation ---

  function calcCharges(subtotalDollars) {
    const subtotalCents = toCents(subtotalDollars);
    const svcCents = state.serviceCharge ? Math.round(subtotalCents * 0.10) : 0;
    const netBeforeGST = subtotalCents + svcCents;
    const gstCents = state.gst ? Math.round(netBeforeGST * 0.09) : 0;
    return { subtotalCents, svcCents, gstCents, grandTotalCents: netBeforeGST + gstCents };
  }

  // --- Split Engines ---

  function splitEqual() {
    const charges = calcCharges(state.subtotal);
    const shares = distributeAmount(charges.grandTotalCents, state.people.length);
    return state.people.map((p, i) => ({ name: p.name, amountCents: shares[i], details: [] }));
  }

  function splitPerItem() {
    const itemSubtotalCents = state.items.reduce((s, it) => s + toCents(it.price), 0);
    if (itemSubtotalCents === 0) return state.people.map(p => ({ name: p.name, amountCents: 0, details: [] }));

    const personItemCents = {};
    const personDetails = {};
    state.people.forEach(p => { personItemCents[p.id] = 0; personDetails[p.id] = []; });

    state.items.forEach(item => {
      const assignees = item.assignedTo.filter(id => state.people.some(p => p.id === id));
      if (assignees.length === 0) return;
      const shares = distributeAmount(toCents(item.price), assignees.length);
      assignees.forEach((pid, i) => {
        personItemCents[pid] += shares[i];
        personDetails[pid].push(item.name + ' ' + formatSGD(toDollars(shares[i])));
      });
    });

    const charges = calcCharges(toDollars(itemSubtotalCents));
    const weights = state.people.map(p => personItemCents[p.id]);
    const svcShares = distributeProportion(charges.svcCents, weights);
    const gstShares = distributeProportion(charges.gstCents, weights);

    return state.people.map((p, i) => ({
      name: p.name,
      amountCents: personItemCents[p.id] + svcShares[i] + gstShares[i],
      details: personDetails[p.id]
    }));
  }

  function splitCustom() {
    const charges = calcCharges(state.subtotal);
    const grandCents = charges.grandTotalCents;

    if (state.customType === 'percent') {
      const percents = state.people.map(p => parseFloat(state.customAllocations[p.id]) || 0);
      let allocated = 0;
      const shares = percents.map((pct, i) => {
        if (i === percents.length - 1) return grandCents - allocated;
        const share = Math.floor(grandCents * pct / 100);
        allocated += share;
        return share;
      });
      return state.people.map((p, i) => ({ name: p.name, amountCents: shares[i], details: [percents[i].toFixed(1) + '%'] }));
    }

    return state.people.map(p => ({
      name: p.name,
      amountCents: toCents(parseFloat(state.customAllocations[p.id]) || 0),
      details: []
    }));
  }

  // --- DOM Helpers ---

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Render ---

  function renderBreakdown() {
    const charges = calcCharges(state.subtotal);
    $('#breakdown-subtotal').textContent = formatSGD(state.subtotal);
    $('#breakdown-svc').textContent = formatSGD(toDollars(charges.svcCents));
    $('#breakdown-gst').textContent = formatSGD(toDollars(charges.gstCents));
    $('#breakdown-total').textContent = formatSGD(toDollars(charges.grandTotalCents));
    $('#svc-row').classList.toggle('hidden', !state.serviceCharge);
    $('#gst-row').classList.toggle('hidden', !state.gst);
  }

  function renderPeople() {
    const list = $('#people-list');
    list.innerHTML = '';
    state.people.forEach(p => {
      const li = document.createElement('li');
      li.className = 'person-item';
      li.innerHTML = `<span class="person-name">${escapeHtml(p.name)}</span><button class="person-remove" data-id="${p.id}">&times;</button>`;
      list.appendChild(li);
    });
    $('#people-hint').style.display = state.people.length >= 2 ? 'none' : 'block';
  }

  function renderModeUI() {
    $('#section-perItem').classList.toggle('hidden', state.splitMode !== 'perItem');
    $('#section-custom').classList.toggle('hidden', state.splitMode !== 'custom');

    if (state.splitMode === 'perItem') renderItems();
    if (state.splitMode === 'custom') renderCustomAllocations();
  }

  function renderItems() {
    const list = $('#items-list');
    list.innerHTML = '';

    state.items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'item-card';
      const isEditing = state.editingItemId === item.id;
      const isDropdownOpen = state.openDropdownId === item.id;

      const assignedNames = item.assignedTo
        .map(pid => state.people.find(p => p.id === pid))
        .filter(Boolean)
        .map(p => escapeHtml(p.name));
      const assignLabel = assignedNames.length > 0
        ? `<span class="assigned-names">${assignedNames.join(', ')}</span>`
        : 'Assign people';

      if (isEditing) {
        div.innerHTML = `
          <div class="item-edit-form">
            <input type="text" class="edit-item-name" data-id="${item.id}" value="${escapeHtml(item.name)}" maxlength="40">
            <div class="currency-input currency-input-sm">
              <span class="currency-symbol">S$</span>
              <input type="number" class="edit-item-price" data-id="${item.id}" value="${item.price}" min="0" step="0.01" inputmode="decimal">
            </div>
            <div class="item-edit-actions">
              <button class="item-save" data-id="${item.id}">Save</button>
              <button class="item-cancel" data-id="${item.id}">Cancel</button>
            </div>
          </div>
          <div class="item-assign">
            <button class="item-assign-toggle" data-id="${item.id}">
              ${assignLabel}
              <span class="arrow">&#9662;</span>
            </button>
            ${renderDropdown(item, isDropdownOpen)}
          </div>
        `;
      } else {
        div.innerHTML = `
          <div class="item-header">
            <span class="item-name">${escapeHtml(item.name)}</span>
            <div class="item-actions">
              <span class="item-price">${formatSGD(item.price)}</span>
              <button class="item-edit" data-id="${item.id}" title="Edit">&#9998;</button>
              <button class="item-remove" data-id="${item.id}" title="Remove">&times;</button>
            </div>
          </div>
          <div class="item-assign">
            <button class="item-assign-toggle" data-id="${item.id}">
              ${assignLabel}
              <span class="arrow">&#9662;</span>
            </button>
            ${renderDropdown(item, isDropdownOpen)}
          </div>
        `;
      }
      list.appendChild(div);
    });

    const hasItems = state.items.length > 0;
    const itemSubtotal = state.items.reduce((s, it) => s + it.price, 0);
    const itemSubtotalCents = toCents(itemSubtotal);

    $('#item-subtotal-display').textContent = formatSGD(itemSubtotal);
    $('#item-subtotal-row').classList.toggle('hidden', !hasItems);
    $('#items-hint').style.display = hasItems ? 'none' : 'block';

    // AC2: charges and discrepancy
    const hasCharges = state.serviceCharge || state.gst;
    const itemCharges = calcCharges(itemSubtotal);
    const chargesAmount = itemCharges.svcCents + itemCharges.gstCents;

    const chargesRow = $('#item-charges-row');
    const grandRow = $('#item-grand-row');
    const discrepancy = $('#item-discrepancy');

    if (hasItems && hasCharges) {
      let chargesLabel = '+ ';
      const parts = [];
      if (state.serviceCharge) parts.push('Svc ' + formatSGD(toDollars(itemCharges.svcCents)));
      if (state.gst) parts.push('GST ' + formatSGD(toDollars(itemCharges.gstCents)));
      chargesLabel += parts.join(' + ');
      $('#item-charges-label').textContent = chargesLabel;
      $('#item-charges-display').textContent = formatSGD(toDollars(chargesAmount));
      chargesRow.classList.remove('hidden');
      $('#item-grand-display').textContent = formatSGD(toDollars(itemCharges.grandTotalCents));
      grandRow.classList.remove('hidden');
    } else {
      chargesRow.classList.add('hidden');
      grandRow.classList.add('hidden');
    }

    // AC2: compare against bill details
    if (hasItems && state.subtotal > 0) {
      const billCharges = calcCharges(state.subtotal);
      const diff = billCharges.grandTotalCents - itemCharges.grandTotalCents;
      if (diff === 0) {
        discrepancy.textContent = 'Items match the bill total';
        discrepancy.className = 'item-discrepancy match';
      } else {
        const diffDollars = toDollars(Math.abs(diff));
        const direction = diff > 0 ? 'under' : 'over';
        discrepancy.textContent = `Items are ${formatSGD(diffDollars)} ${direction} the bill total (${formatSGD(toDollars(billCharges.grandTotalCents))})`;
        discrepancy.className = 'item-discrepancy mismatch';
      }
    } else {
      discrepancy.className = 'item-discrepancy hidden';
    }
  }

  function renderDropdown(item, isOpen) {
    if (state.people.length === 0) {
      return `<div class="item-assign-dropdown ${isOpen ? '' : 'hidden'}" data-dropdown="${item.id}">
        <div class="assign-option" style="color:var(--text-muted);cursor:default">Add people first</div>
      </div>`;
    }
    return `<div class="item-assign-dropdown ${isOpen ? '' : 'hidden'}" data-dropdown="${item.id}">
      ${state.people.map(p => {
        const selected = item.assignedTo.includes(p.id);
        return `<button class="assign-option ${selected ? 'selected' : ''}" data-item="${item.id}" data-person="${p.id}">
          <span class="assign-check">${selected ? '&#10003;' : ''}</span>
          ${escapeHtml(p.name)}
        </button>`;
      }).join('')}
    </div>`;
  }

  function renderCustomAllocations() {
    const container = $('#custom-allocations');
    container.innerHTML = '';
    const isPercent = state.customType === 'percent';

    state.people.forEach(p => {
      const val = state.customAllocations[p.id] || '';
      const div = document.createElement('div');
      div.className = 'allocation-row';
      div.innerHTML = `
        <span class="allocation-name">${escapeHtml(p.name)}</span>
        ${!isPercent ? '<span class="allocation-suffix">S$</span>' : ''}
        <input type="number" class="allocation-input" data-person="${p.id}"
               value="${val}" min="0" step="${isPercent ? '0.1' : '0.01'}"
               placeholder="0" inputmode="decimal">
        ${isPercent ? '<span class="allocation-suffix">%</span>' : ''}
      `;
      container.appendChild(div);
    });

    $$('.custom-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.custom === state.customType));
    updateCustomRemaining();
  }

  function updateCustomRemaining() {
    const charges = calcCharges(state.subtotal);
    const isPercent = state.customType === 'percent';
    const row = $('#remaining-row');

    if (isPercent) {
      const used = state.people.reduce((s, p) => s + (parseFloat(state.customAllocations[p.id]) || 0), 0);
      const remaining = 100 - used;
      $('#remaining-display').textContent = remaining.toFixed(1) + '%';
      row.classList.toggle('over', remaining < -0.15);
      row.classList.toggle('exact', Math.abs(remaining) < 0.15);
    } else {
      const used = state.people.reduce((s, p) => s + toCents(parseFloat(state.customAllocations[p.id]) || 0), 0);
      const remainingCents = charges.grandTotalCents - used;
      $('#remaining-display').textContent = formatSGD(toDollars(remainingCents));
      row.classList.toggle('over', remainingCents < 0);
      row.classList.toggle('exact', remainingCents === 0);
    }
  }

  function canShowResults() {
    if (state.people.length < 2) return false;

    if (state.splitMode === 'equal') {
      return state.subtotal > 0;
    }
    if (state.splitMode === 'perItem') {
      return state.items.length > 0 && state.items.some(it => it.assignedTo.length > 0);
    }
    if (state.splitMode === 'custom') {
      const charges = calcCharges(state.subtotal);
      if (state.customType === 'percent') {
        const total = state.people.reduce((s, p) => s + (parseFloat(state.customAllocations[p.id]) || 0), 0);
        return Math.abs(total - 100) < 0.15;
      }
      const used = state.people.reduce((s, p) => s + toCents(parseFloat(state.customAllocations[p.id]) || 0), 0);
      return used === charges.grandTotalCents && charges.grandTotalCents > 0;
    }
    return false;
  }

  function renderResults() {
    const section = $('#section-results');
    if (!canShowResults()) {
      section.classList.add('hidden');
      return;
    }

    let results;
    if (state.splitMode === 'equal') results = splitEqual();
    else if (state.splitMode === 'perItem') results = splitPerItem();
    else results = splitCustom();

    const cards = $('#result-cards');
    cards.innerHTML = '';
    results.forEach(r => {
      const div = document.createElement('div');
      div.className = 'result-card';
      div.innerHTML = `
        <div>
          <div class="result-name">${escapeHtml(r.name)}</div>
          ${r.details.length ? `<div class="result-details">${r.details.map(escapeHtml).join(', ')}</div>` : ''}
        </div>
        <div class="result-amount">${formatSGD(toDollars(r.amountCents))}</div>
      `;
      cards.appendChild(div);
    });

    const totalCents = results.reduce((s, r) => s + r.amountCents, 0);
    $('#total-check').textContent = 'Total: ' + formatSGD(toDollars(totalCents));

    section.classList.remove('hidden');
    state._lastResults = results;
  }

  function update() {
    renderBreakdown();
    renderModeUI();
    renderResults();
  }

  // --- Copy Summary ---

  function copySummary() {
    const results = state._lastResults;
    if (!results) return;

    const sub = state.splitMode === 'perItem'
      ? toDollars(state.items.reduce((s, it) => s + toCents(it.price), 0))
      : state.subtotal;
    const charges = calcCharges(sub);

    let lines = ['SplitLah Summary', ''];
    lines.push('Grand Total: ' + formatSGD(toDollars(charges.grandTotalCents)));
    if (state.serviceCharge) lines.push('  incl. Service Charge: ' + formatSGD(toDollars(charges.svcCents)));
    if (state.gst) lines.push('  incl. GST: ' + formatSGD(toDollars(charges.gstCents)));
    lines.push('');
    results.forEach(r => lines.push(r.name + ': ' + formatSGD(toDollars(r.amountCents))));

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      const fb = $('#copy-feedback');
      fb.classList.remove('hidden');
      setTimeout(() => fb.classList.add('hidden'), 2000);
    });
  }

  // --- Event Listeners ---

  // Bill details
  $('#subtotal-input').addEventListener('input', (e) => {
    state.subtotal = parseFloat(e.target.value) || 0;
    update();
  });
  $('#svc-toggle').addEventListener('change', (e) => { state.serviceCharge = e.target.checked; update(); });
  $('#gst-toggle').addEventListener('change', (e) => { state.gst = e.target.checked; update(); });

  // Mode selection
  $$('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      state.splitMode = card.dataset.mode;
      $$('.mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      update();
    });
  });

  // People
  function addPerson() {
    const input = $('#person-input');
    const name = input.value.trim();
    if (!name) return;
    state.people.push({ id: genId(), name });
    input.value = '';
    input.focus();
    renderPeople();
    if (state.splitMode === 'perItem') renderItems();
    if (state.splitMode === 'custom') renderCustomAllocations();
    renderResults();
  }

  $('#btn-add-person').addEventListener('click', addPerson);
  $('#person-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addPerson(); });

  $('#people-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.person-remove');
    if (!btn) return;
    const id = btn.dataset.id;
    state.people = state.people.filter(p => p.id !== id);
    state.items.forEach(item => { item.assignedTo = item.assignedTo.filter(pid => pid !== id); });
    delete state.customAllocations[id];
    renderPeople();
    update();
  });

  // Per-item
  function addItem() {
    const nameInput = $('#item-name-input');
    const priceInput = $('#item-price-input');
    const name = nameInput.value.trim();
    const price = parseFloat(priceInput.value) || 0;
    if (!name || price <= 0) return;
    state.items.push({ id: genId(), name, price, assignedTo: [] });
    nameInput.value = '';
    priceInput.value = '';
    nameInput.focus();
    renderItems();
    renderResults();
  }

  $('#btn-add-item').addEventListener('click', addItem);
  $('#item-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#item-price-input').focus(); } });
  $('#item-price-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });

  $('#items-list').addEventListener('click', (e) => {
    // Dropdown toggle
    const toggle = e.target.closest('.item-assign-toggle');
    if (toggle) {
      const id = toggle.dataset.id;
      state.openDropdownId = state.openDropdownId === id ? null : id;
      renderItems();
      return;
    }

    // Dropdown option select/deselect
    const option = e.target.closest('.assign-option');
    if (option && option.dataset.person) {
      const item = state.items.find(it => it.id === option.dataset.item);
      if (!item) return;
      const pid = option.dataset.person;
      const idx = item.assignedTo.indexOf(pid);
      if (idx >= 0) item.assignedTo.splice(idx, 1); else item.assignedTo.push(pid);
      renderItems();
      renderResults();
      return;
    }

    // Edit button
    const editBtn = e.target.closest('.item-edit');
    if (editBtn) {
      state.editingItemId = editBtn.dataset.id;
      renderItems();
      const nameInput = $(`.edit-item-name[data-id="${editBtn.dataset.id}"]`);
      if (nameInput) nameInput.focus();
      return;
    }

    // Save edit
    const saveBtn = e.target.closest('.item-save');
    if (saveBtn) {
      const item = state.items.find(it => it.id === saveBtn.dataset.id);
      if (!item) return;
      const nameInput = $(`.edit-item-name[data-id="${item.id}"]`);
      const priceInput = $(`.edit-item-price[data-id="${item.id}"]`);
      const newName = nameInput.value.trim();
      const newPrice = parseFloat(priceInput.value) || 0;
      if (newName) item.name = newName;
      if (newPrice > 0) item.price = newPrice;
      state.editingItemId = null;
      renderItems();
      renderResults();
      return;
    }

    // Cancel edit
    const cancelBtn = e.target.closest('.item-cancel');
    if (cancelBtn) {
      state.editingItemId = null;
      renderItems();
      return;
    }

    // Remove item
    const removeBtn = e.target.closest('.item-remove');
    if (removeBtn) {
      state.items = state.items.filter(it => it.id !== removeBtn.dataset.id);
      if (state.editingItemId === removeBtn.dataset.id) state.editingItemId = null;
      if (state.openDropdownId === removeBtn.dataset.id) state.openDropdownId = null;
      renderItems();
      renderResults();
    }
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (state.openDropdownId && !e.target.closest('.item-assign')) {
      state.openDropdownId = null;
      renderItems();
    }
  });

  // Custom
  $$('.custom-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.customType = tab.dataset.custom;
      state.customAllocations = {};
      renderCustomAllocations();
      renderResults();
    });
  });

  $('#custom-allocations').addEventListener('input', (e) => {
    const input = e.target.closest('.allocation-input');
    if (!input) return;
    state.customAllocations[input.dataset.person] = input.value;
    updateCustomRemaining();
    renderResults();
  });

  $('#btn-even-split').addEventListener('click', () => {
    if (state.customType === 'percent') {
      const n = state.people.length;
      const base = Math.floor(1000 / n) / 10;
      state.people.forEach((p, i) => {
        state.customAllocations[p.id] = (i === n - 1)
          ? (100 - base * (n - 1)).toFixed(1)
          : base.toFixed(1);
      });
    } else {
      const charges = calcCharges(state.subtotal);
      const shares = distributeAmount(charges.grandTotalCents, state.people.length);
      state.people.forEach((p, i) => { state.customAllocations[p.id] = toDollars(shares[i]).toFixed(2); });
    }
    renderCustomAllocations();
    renderResults();
  });

  // Copy & Reset
  $('#btn-copy').addEventListener('click', copySummary);

  $('#btn-start-over').addEventListener('click', () => {
    state.subtotal = 0;
    state.serviceCharge = false;
    state.gst = false;
    state.splitMode = 'equal';
    state.people = [];
    state.items = [];
    state.customAllocations = {};
    state.customType = 'amount';
    state._lastResults = null;

    $('#subtotal-input').value = '';
    $('#svc-toggle').checked = false;
    $('#gst-toggle').checked = false;
    $$('.mode-card').forEach(c => c.classList.remove('selected'));
    $('[data-mode="equal"]').classList.add('selected');

    renderPeople();
    update();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Init
  update();
})();
