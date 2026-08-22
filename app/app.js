(() => {
  "use strict";

  const data = window.APPLIANCE_DATA;
  if (!data?.app || !Array.isArray(data.makers) || !Array.isArray(data.products)) {
    document.body.innerHTML = '<p class="fatal-error">商品データを読み込めませんでした。</p>';
    return;
  }

  const { app, makers, products } = data;
  const grades = data.grades || [];
  const needs = data.needs || [];
  const featureGroups = data.featureGroups || [];
  const sources = data.sources || [];
  const comparison = data.comparison || { groups: [], fields: [], productSpecs: {} };
  const compareLimit = app.compareLimit || 7;
  const electricityRate = comparison.electricityRateYenPerKwh || 31;

  const byMaker = Object.fromEntries(makers.map((maker) => [maker.id, maker]));
  const byProduct = Object.fromEntries(products.map((product) => [product.id, product]));
  const byNeed = Object.fromEntries(needs.map((need) => [need.id, need]));
  const bySource = Object.fromEntries(sources.map((source) => [source.id, source]));
  const byCatalogSource = Object.fromEntries((comparison.catalogSources || []).map((source) => [source.id, source]));
  const keyFields = (comparison.fields || []).filter((field) => field.key);

  const releaseYears = ["2026", "2025"];
  const capacityBands = [
    { id: "500-plus", label: "500L以上", test: (value) => value >= 500 },
    { id: "400s", label: "400〜499L", test: (value) => value >= 400 && value < 500 },
    { id: "300s", label: "300〜399L", test: (value) => value >= 300 && value < 400 },
    { id: "under-300", label: "300L未満", test: (value) => value < 300 }
  ];
  const widthBands = [
    { id: "600", label: "600mm以下", test: (value) => value <= 600 },
    { id: "650", label: "650mm以下", test: (value) => value <= 650 },
    { id: "700", label: "700mm以下", test: (value) => value <= 700 }
  ];
  const doorBands = [
    { id: "french", label: "観音開き", test: (value) => /フレンチ|観音|両開き/.test(value || "") },
    { id: "reversible", label: "右・左を選べる", test: (value) => /右開き.*左開き|左開き.*右開き/.test(value || "") },
    { id: "single", label: "片開き", test: (value) => /片開き|右開き|左開き/.test(value || "") && !/フレンチ|観音|両開き/.test(value || "") }
  ];
  const layoutBands = [
    { id: "center-freezer", label: "真ん中冷凍", test: (spec) => spec.layout?.centerFreezer === true },
    { id: "center-vegetable", label: "真ん中野菜", test: (spec) => spec.layout?.centerVegetable === true },
    { id: "freezing", label: "冷凍重視", test: (spec) => isAvailable(spec.freezing?.quick) || isAvailable(spec.freezing?.quality) || freezerRatio(spec) >= 25 },
    { id: "vegetables", label: "野菜重視", test: (spec) => isAvailable(spec.vegetables?.freshness) },
    { id: "meat-fish", label: "肉・魚保存", test: (spec) => isAvailable(spec.meatFish?.freshness) },
    { id: "automatic-ice", label: "自動製氷", test: (spec) => isAvailable(spec.ice?.automatic) }
  ];
  const energyBands = [
    { id: "270", label: "270kWh以下", test: (value) => value <= 270 },
    { id: "300", label: "300kWh以下", test: (value) => value <= 300 }
  ];

  const state = {
    makers: new Set(),
    grades: new Set(),
    years: new Set(),
    capacities: new Set(),
    widths: new Set(),
    doors: new Set(),
    layouts: new Set(),
    energies: new Set(),
    search: "",
    compare: [],
    differencesOnly: false,
    openGroups: new Set()
  };

  let detailTrigger = null;
  let detailProductId = null;

  const elements = {
    makerFilters: document.querySelector("#makerFilters"),
    gradeFilters: document.querySelector("#gradeFilters"),
    gradeFilterBlock: document.querySelector("#gradeFilterBlock"),
    yearFilters: document.querySelector("#yearFilters"),
    capacityFilters: document.querySelector("#capacityFilters"),
    widthFilters: document.querySelector("#widthFilters"),
    doorFilters: document.querySelector("#doorFilters"),
    layoutFilters: document.querySelector("#layoutFilters"),
    energyFilters: document.querySelector("#energyFilters"),
    searchInput: document.querySelector("#searchInput"),
    productGrid: document.querySelector("#productGrid"),
    resultTitle: document.querySelector("#resultTitle"),
    resultsStatus: document.querySelector("#resultsStatus"),
    activeFilterSummary: document.querySelector("#activeFilterSummary"),
    visibleCount: document.querySelector("#visibleCount"),
    mobileVisibleCount: document.querySelector("#mobileVisibleCount"),
    compareEmpty: document.querySelector("#compareEmpty"),
    compareControls: document.querySelector("#compareControls"),
    compareTableWrap: document.querySelector("#compareTableWrap"),
    compareScrollHint: document.querySelector("#compareScrollHint"),
    compareStatus: document.querySelector("#compareStatus"),
    differencesOnly: document.querySelector("#differencesOnly"),
    makerGuide: document.querySelector("#makerGuide"),
    detailDialog: document.querySelector("#detailDialog"),
    detailDialogContent: document.querySelector("#detailDialogContent")
  };

  initialize();

  function initialize() {
    applyLabels();
    bindEvents();
    renderMakerGuide();
    renderAll();
  }

  function applyLabels() {
    document.title = app.title;
    document.querySelector("#appKicker").textContent = app.kicker;
    document.querySelector("#appTitle").textContent = app.title;
    document.querySelector("#makerCount").textContent = makers.length;
    document.querySelector("#makerCountLabel").textContent = app.makerLabel;
    document.querySelector("#itemCount").textContent = products.length;
    document.querySelector("#itemCountLabel").textContent = app.itemLabel;
    document.querySelector("#makerFilterTitle").textContent = app.makerLabel;
    document.querySelector("#gradeFilterTitle").textContent = app.gradeLabel;
    document.querySelector("#listKicker").textContent = `${app.itemLabel}一覧`;
    document.querySelector("#salesNote").textContent = app.salesNote;
    elements.searchInput.placeholder = "型番・メーカー・シリーズ・機能名で検索";
    elements.compareEmpty.textContent = `${app.itemLabel}カードの「比較に追加」で、2〜${compareLimit}件を横並び比較できます。`;
    elements.gradeFilterBlock.hidden = grades.length === 0;
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const filter = event.target.closest("[data-filter-group]");
      if (filter) {
        toggleFilter(filter.dataset.filterGroup, filter.dataset.filterValue);
        return;
      }

      const compareButton = event.target.closest("[data-compare-id]");
      if (compareButton) {
        toggleCompare(compareButton.dataset.compareId);
        return;
      }

      const detailButton = event.target.closest("[data-detail-id]");
      if (detailButton) {
        detailTrigger = detailButton;
        openDetail(detailButton.dataset.detailId);
        return;
      }

      const groupButton = event.target.closest("[data-compare-group]");
      if (groupButton) {
        const groupId = groupButton.dataset.compareGroup;
        state.openGroups.has(groupId) ? state.openGroups.delete(groupId) : state.openGroups.add(groupId);
        renderCompare();
        return;
      }

      const makerLink = event.target.closest("[data-maker-link]");
      if (makerLink) {
        event.preventDefault();
        clearFilterState();
        state.makers.add(makerLink.dataset.makerLink);
        renderAll();
        moveTo("results");
        return;
      }

      if (event.target.closest("[data-close-dialog]")) closeDetail();
    });

    elements.searchInput.addEventListener("input", () => {
      state.search = elements.searchInput.value;
      renderAll();
    });

    document.querySelector("#clearFilters").addEventListener("click", () => {
      clearFilterState();
      elements.searchInput.value = "";
      renderAll();
      elements.searchInput.focus();
    });

    document.querySelector("#clearCompare").addEventListener("click", () => {
      state.compare = [];
      renderAll();
      elements.compareStatus.textContent = "比較リストを空にしました。";
    });

    elements.differencesOnly.addEventListener("change", () => {
      state.differencesOnly = elements.differencesOnly.checked;
      renderCompare();
    });

    document.querySelector("#expandCompareGroups").addEventListener("click", () => {
      state.openGroups = new Set((comparison.groups || []).map((group) => group.id));
      renderCompare();
    });

    document.querySelector("#collapseCompareGroups").addEventListener("click", () => {
      state.openGroups.clear();
      renderCompare();
    });

    elements.detailDialog.addEventListener("click", (event) => {
      if (event.target === elements.detailDialog) closeDetail();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && elements.detailDialog.open) {
        event.preventDefault();
        closeDetail();
      }
    });

    elements.detailDialog.addEventListener("close", () => {
      const returnTarget = detailTrigger && document.contains(detailTrigger)
        ? detailTrigger
        : document.querySelector(`[data-detail-id="${detailProductId}"]`);
      returnTarget?.focus();
      detailTrigger = null;
      detailProductId = null;
    });

    document.addEventListener("error", (event) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      event.target.hidden = true;
      const fallback = event.target.parentElement?.querySelector(".media-fallback");
      if (fallback) fallback.hidden = false;
    }, true);
  }

  function toggleFilter(group, value) {
    const targetSet = {
      maker: state.makers,
      grade: state.grades,
      year: state.years,
      capacity: state.capacities,
      width: state.widths,
      door: state.doors,
      layout: state.layouts,
      energy: state.energies
    }[group];
    if (!targetSet) return;
    targetSet.has(value) ? targetSet.delete(value) : targetSet.add(value);
    renderAll();
  }

  function clearFilterState() {
    [state.makers, state.grades, state.years, state.capacities, state.widths, state.doors, state.layouts, state.energies]
      .forEach((set) => set.clear());
    state.search = "";
    elements.searchInput.value = "";
  }

  function renderAll() {
    renderFilters();
    renderProducts();
    renderCompare();
    updateCompareCounts();
  }

  function renderFilters() {
    elements.makerFilters.innerHTML = makers.map((maker) => filterChip("maker", maker.id, maker.name, state.makers)).join("");
    elements.gradeFilters.innerHTML = grades.map((grade) => filterChip("grade", grade, grade, state.grades)).join("");
    elements.yearFilters.innerHTML = releaseYears.map((year) => filterChip("year", year, `${year}年`, state.years)).join("");
    elements.capacityFilters.innerHTML = capacityBands.map((band) => filterChip("capacity", band.id, band.label, state.capacities)).join("");
    elements.widthFilters.innerHTML = widthBands.map((band) => filterChip("width", band.id, band.label, state.widths)).join("");
    elements.doorFilters.innerHTML = doorBands.map((band) => filterChip("door", band.id, band.label, state.doors)).join("");
    elements.layoutFilters.innerHTML = layoutBands.map((band) => filterChip("layout", band.id, band.label, state.layouts)).join("");
    elements.energyFilters.innerHTML = energyBands.map((band) => filterChip("energy", band.id, band.label, state.energies)).join("");
  }

  function filterChip(group, value, label, selectedSet) {
    const active = selectedSet.has(value);
    return `<button class="chip${active ? " is-active" : ""}" type="button" data-filter-group="${group}" data-filter-value="${escapeAttr(value)}" aria-pressed="${active}">${active ? '<span class="selected-mark" aria-hidden="true">✓</span>' : ""}<span>${escapeHtml(label)}</span></button>`;
  }

  function filteredProducts() {
    const query = normalize(state.search);
    return products.filter((product) => {
      const spec = productSpec(product);
      if (state.makers.size && !state.makers.has(product.makerId)) return false;
      if (state.grades.size && !state.grades.has(product.grade)) return false;
      if (state.years.size && !state.years.has(productYear(product))) return false;
      if (state.capacities.size && !matchesAny(state.capacities, capacityBands, spec.size?.totalL)) return false;
      if (state.widths.size && !matchesAny(state.widths, widthBands, spec.size?.widthMm)) return false;
      if (state.doors.size && !matchesAny(state.doors, doorBands, spec.basic?.doorType)) return false;
      if (state.layouts.size && !matchesAny(state.layouts, layoutBands, spec)) return false;
      if (state.energies.size && !matchesAny(state.energies, energyBands, spec.energy?.annualKwh)) return false;
      if (!query) return true;
      const maker = byMaker[product.makerId];
      const needText = (product.needIds || []).flatMap((id) => [byNeed[id]?.label, byNeed[id]?.customerPhrase]);
      const featureText = (product.features || []).flatMap((feature) => [feature.name, feature.description]);
      return normalize([
        maker?.name, product.name, product.grade, product.headline, product.talk, product.model, product.fit,
        ...(product.aliases || []), ...(product.tags || []), ...needText, ...featureText, JSON.stringify(spec)
      ].join(" ")).includes(query);
    });
  }

  function matchesAny(selected, definitions, value) {
    if (value === null || value === undefined || value === "") return false;
    return definitions.some((definition) => selected.has(definition.id) && definition.test(value));
  }

  function renderProducts() {
    const visible = filteredProducts();
    const filterCount = activeFilterCount();
    elements.visibleCount.textContent = visible.length;
    elements.mobileVisibleCount.textContent = visible.length;
    elements.resultTitle.textContent = filterCount ? `${visible.length}件を表示` : app.allItemsLabel;
    elements.resultsStatus.textContent = `${visible.length}件の${app.itemLabel}を表示しています。`;
    elements.activeFilterSummary.innerHTML = filterCount
      ? `<strong>${filterCount}条件を適用中</strong><span>同じグループ内はOR、異なるグループ間はANDです。</span>`
      : "";

    if (!visible.length) {
      elements.productGrid.innerHTML = '<div class="no-results">条件に合う商品がありません。キーワードや絞り込みを変更してください。</div>';
      return;
    }
    elements.productGrid.innerHTML = visible.map(productCard).join("");
  }

  function activeFilterCount() {
    return [state.makers, state.grades, state.years, state.capacities, state.widths, state.doors, state.layouts, state.energies]
      .reduce((total, set) => total + set.size, state.search.trim() ? 1 : 0);
  }

  function productCard(product) {
    const maker = byMaker[product.makerId];
    const spec = productSpec(product);
    const selected = state.compare.includes(product.id);
    const compareDisabled = !selected && state.compare.length >= compareLimit;
    const image = product.cover || maker.logo;
    const keyFacts = [
      spec.size?.totalL != null ? `${spec.size.totalL}L` : null,
      spec.size?.widthMm != null ? `幅${spec.size.widthMm}mm` : null,
      productYear(product) ? `${productYear(product)}年` : null,
      spec.layout?.centerFreezer ? "真ん中冷凍" : null,
      spec.layout?.centerVegetable ? "真ん中野菜" : null
    ].filter(Boolean);
    const recommendations = recommendedUsers(product).slice(0, 3);

    return `<article class="series-card" style="--accent:${safeColor(maker.accent)}">
      <div class="card-media">
        ${image ? `<img src="${escapeAttr(image)}" alt="${escapeAttr(maker.name)} ロゴ" />` : ""}
        <span class="media-fallback"${image ? " hidden" : ""}>${escapeHtml(maker.name)}</span>
      </div>
      <div class="card-body">
        <div class="maker-label"><span>${escapeHtml(maker.name)}</span><span>${escapeHtml(spec.basic?.release || product.model || "")}</span></div>
        <div class="series-title"><h3>${escapeHtml(product.name)}</h3>${product.grade ? `<span class="grade">${escapeHtml(product.grade)}</span>` : ""}</div>
        ${product.headline ? `<p class="headline">${escapeHtml(product.headline)}</p>` : ""}
        <div class="card-key-facts">${keyFacts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>
        ${recommendations.length ? `<div class="card-recommendation"><strong>おすすめ</strong><span>${escapeHtml(recommendations.join("・"))}</span></div>` : ""}
        <div class="card-actions">
          <button class="db-button" type="button" data-detail-id="${escapeAttr(product.id)}">詳しく見る</button>
          <button class="compare-button${selected ? " is-selected" : ""}" type="button" data-compare-id="${escapeAttr(product.id)}" ${compareDisabled ? "disabled" : ""} aria-pressed="${selected}">${selected ? "比較から外す" : "比較に追加"}</button>
        </div>
      </div>
    </article>`;
  }

  function toggleCompare(productId) {
    if (!byProduct[productId]) return;
    if (state.compare.includes(productId)) {
      state.compare = state.compare.filter((id) => id !== productId);
      elements.compareStatus.textContent = `${byProduct[productId].name}を比較から外しました。`;
    } else if (state.compare.length < compareLimit) {
      state.compare.push(productId);
      elements.compareStatus.textContent = `${byProduct[productId].name}を比較に追加しました。`;
    } else {
      elements.compareStatus.textContent = `比較できるのは最大${compareLimit}件です。`;
    }
    renderAll();
    if (detailProductId && elements.detailDialog.open && byProduct[detailProductId]) {
      elements.detailDialogContent.innerHTML = detailTemplate(byProduct[detailProductId]);
    }
  }

  function renderCompare() {
    const items = state.compare.map((id) => byProduct[id]).filter(Boolean);
    elements.compareEmpty.hidden = items.length > 0;
    elements.compareControls.hidden = items.length === 0;
    elements.compareTableWrap.hidden = items.length === 0;
    elements.compareScrollHint.hidden = items.length < 4;
    elements.differencesOnly.checked = state.differencesOnly;
    if (!items.length) {
      elements.compareTableWrap.innerHTML = "";
      return;
    }
    elements.compareTableWrap.innerHTML = `${keyCompareTable(items)}${detailedCompareTable(items)}${mobileCompareCards(items)}${salesCards(items)}`;
  }

  function keyCompareTable(items) {
    const fields = state.differencesOnly ? keyFields.filter((field) => fieldHasDifference(field, items)) : keyFields;
    return `<div class="compare-block-title"><span>主要比較項目</span><small>数値の「ベスト」は選択中の機種内で判定</small></div>${baseCompareTable(items, fields, "key-compare-table")}`;
  }

  function detailedCompareTable(items) {
    const header = compareHeader(items);
    const groupRows = (comparison.groups || []).map((group) => {
      let fields = (comparison.fields || []).filter((field) => field.groupId === group.id && !field.key);
      if (state.differencesOnly) fields = fields.filter((field) => fieldHasDifference(field, items));
      const isOpen = state.openGroups.has(group.id);
      const visibleRows = isOpen ? fields.map((field) => compareRow(field, items)).join("") : "";
      const countLabel = state.differencesOnly ? `${fields.length}差分` : `${fields.length}項目`;
      return `<tr class="compare-group-row"><th colspan="${items.length + 1}"><button type="button" data-compare-group="${escapeAttr(group.id)}" aria-expanded="${isOpen}"><span>${escapeHtml(group.label)}</span><small>${escapeHtml(countLabel)}</small><b aria-hidden="true">${isOpen ? "−" : "+"}</b></button></th></tr>${visibleRows}`;
    }).join("");
    return `<div class="compare-block-title detail-title"><span>カテゴリ別 詳細比較</span><small>カテゴリを開閉できます</small></div><table class="compare-table detailed-compare-table" data-count="${items.length}">${compareColgroup(items)}${header}<tbody>${groupRows}</tbody></table>`;
  }

  function baseCompareTable(items, fields, className) {
    return `<table class="compare-table ${className}" data-count="${items.length}">${compareColgroup(items)}${compareHeader(items)}<tbody>${fields.map((field) => compareRow(field, items)).join("")}</tbody></table>`;
  }

  function compareColgroup(items) {
    return `<colgroup><col class="compare-axis-col" />${items.map(() => '<col class="compare-item-col" />').join("")}</colgroup>`;
  }

  function compareHeader(items) {
    return `<thead><tr><th scope="col">比較項目</th>${items.map((item) => `<th scope="col" style="--accent:${safeColor(byMaker[item.makerId].accent)}"><span>${escapeHtml(byMaker[item.makerId].name)}</span><strong>${escapeHtml(item.name)}</strong><button class="compare-remove-mini" type="button" data-compare-id="${escapeAttr(item.id)}" aria-label="${escapeAttr(item.name)}を比較から外す">外す</button></th>`).join("")}</tr></thead>`;
  }

  function compareRow(field, items) {
    const bestIds = bestProductIds(field, items);
    return `<tr data-field-id="${escapeAttr(field.id)}"><th scope="row">${renderFieldLabel(field)}</th>${items.map((item) => {
      const best = bestIds.has(item.id);
      return `<td class="${best ? "is-best" : ""}">${best ? '<span class="best-badge">ベスト</span>' : ""}${renderFieldValue(field, item, items)}</td>`;
    }).join("")}</tr>`;
  }

  function renderFieldLabel(field) {
    return `<span class="field-label">${escapeHtml(field.label)}</span>${field.help ? `<small class="field-help">${escapeHtml(field.help)}</small>` : ""}`;
  }

  function mobileCompareCards(items) {
    return `<div class="compare-cards">${items.map((item) => {
      const maker = byMaker[item.makerId];
      return `<article class="compare-card" style="--accent:${safeColor(maker.accent)}">
        <div class="compare-card-head"><span>${escapeHtml(maker.name)}</span><strong>${escapeHtml(item.name)}</strong><button type="button" data-compare-id="${escapeAttr(item.id)}">比較から外す</button></div>
        <dl class="mobile-key-list">${keyFields.map((field) => `<div><dt>${renderFieldLabel(field)}</dt><dd>${renderFieldValue(field, item, items)}</dd></div>`).join("")}</dl>
        <div class="mobile-compare-groups">${(comparison.groups || []).map((group) => {
          let fields = (comparison.fields || []).filter((field) => field.groupId === group.id && !field.key);
          if (state.differencesOnly) fields = fields.filter((field) => fieldHasDifference(field, items));
          if (!fields.length) return "";
          return `<details><summary>${escapeHtml(group.label)} <small>${fields.length}項目</small></summary><dl>${fields.map((field) => `<div><dt>${renderFieldLabel(field)}</dt><dd>${renderFieldValue(field, item, items)}</dd></div>`).join("")}</dl></details>`;
        }).join("")}</div>
      </article>`;
    }).join("")}</div>`;
  }

  function salesCards(items) {
    return `<section class="sales-quick-guide" aria-label="商品別の売り分け早見"><div class="compare-block-title"><span>商品別 売り分け早見</span><small>条件ベースのおすすめ＋選択機種内の比較</small></div><div class="sales-card-grid">${items.map((item) => {
      const maker = byMaker[item.makerId];
      return `<article class="sales-card" style="--accent:${safeColor(maker.accent)}"><header><span>${escapeHtml(maker.name)}</span><h3>${escapeHtml(item.name)}</h3></header><section><h4>おすすめ</h4>${inlineList(recommendedUsers(item))}</section><section><h4>強み</h4>${inlineList(productStrengths(item, items))}</section><section><h4>注意点</h4>${inlineList((item.cautions || []).slice(0, 3))}</section></article>`;
    }).join("")}</div></section>`;
  }

  function renderFieldValue(field, product, comparedItems = []) {
    const spec = productSpec(product);
    if (field.type === "recommended") return inlineList(recommendedUsers(product));
    if (field.type === "strengths") return inlineList(productStrengths(product, comparedItems));
    if (field.type === "cautions") return inlineList(product.cautions || []);
    if (field.type === "sourceTrace") return sourceTrace(product);
    if (field.type === "annualCost") {
      const annual = spec.energy?.annualKwh;
      return annual == null ? unknownValue() : `<span class="numeric-value">約${formatNumber(Math.round(annual * electricityRate / 10) * 10)}<small>円/年</small></span><span class="calculation-note">${electricityRate}円/kWhで算出</span>`;
    }
    if (field.type === "freezerRatio") {
      const ratio = freezerRatio(spec);
      return ratio == null ? unknownValue() : `<span class="numeric-value">${ratio.toFixed(1)}<small>%</small></span>`;
    }

    const value = getPath(spec, field.path);
    if (field.type === "capability") return capabilityValue(value);
    if (field.type === "boolean") return booleanValue(value);
    if (field.type === "list") return Array.isArray(value) && value.length ? inlineList(value) : unknownValue();
    if (field.type === "number") return value == null ? unknownValue() : `<span class="numeric-value">${formatNumber(value)}${field.unit ? `<small>${escapeHtml(field.unit)}</small>` : ""}</span>`;
    return value === null || value === undefined || value === "" ? unknownValue() : escapeHtml(value);
  }

  function capabilityValue(value) {
    const available = value?.available;
    if (available === true) return `<span class="status-value status-yes"><b aria-hidden="true">○</b><span>${escapeHtml(value.featureName || "あり")}</span></span>${value.description ? `<small class="value-description">${escapeHtml(value.description)}</small>` : ""}`;
    if (available === false) return '<span class="status-value status-no"><b aria-hidden="true">×</b><span>非搭載</span></span>';
    return unknownValue();
  }

  function booleanValue(value) {
    if (value === true) return '<span class="status-value status-yes"><b aria-hidden="true">○</b><span>該当</span></span>';
    if (value === false) return '<span class="status-value status-no"><b aria-hidden="true">×</b><span>非該当</span></span>';
    return unknownValue();
  }

  function unknownValue() {
    return '<span class="status-value status-unknown"><b aria-hidden="true">－</b><span>未確認</span></span>';
  }

  function fieldHasDifference(field, items) {
    const values = items.map((item) => comparableValue(field, item));
    return new Set(values).size > 1;
  }

  function comparableValue(field, product) {
    const spec = productSpec(product);
    if (field.type === "annualCost") return spec.energy?.annualKwh == null ? "unknown" : String(spec.energy.annualKwh * electricityRate);
    if (field.type === "freezerRatio") return freezerRatio(spec)?.toFixed(3) ?? "unknown";
    if (field.type === "recommended") return recommendedUsers(product).join("|");
    if (field.type === "strengths") return productStrengths(product, []).join("|");
    if (field.type === "cautions") return (product.cautions || []).join("|");
    if (field.type === "sourceTrace") return spec.source?.sourceId || "unknown";
    const value = getPath(spec, field.path);
    if (field.type === "capability") return value?.available == null ? "unknown" : `${value.available}:${value.featureName || ""}`;
    return JSON.stringify(value ?? null);
  }

  function bestProductIds(field, items) {
    if (!field.direction || items.length < 2) return new Set();
    const values = items.map((item) => [item.id, numericFieldValue(field, item)]).filter(([, value]) => Number.isFinite(value));
    if (values.length < 2 || new Set(values.map(([, value]) => value)).size < 2) return new Set();
    const best = field.direction === "lower" ? Math.min(...values.map(([, value]) => value)) : Math.max(...values.map(([, value]) => value));
    return new Set(values.filter(([, value]) => value === best).map(([id]) => id));
  }

  function numericFieldValue(field, product) {
    const spec = productSpec(product);
    if (field.type === "annualCost") return spec.energy?.annualKwh == null ? null : spec.energy.annualKwh * electricityRate;
    if (field.type === "freezerRatio") return freezerRatio(spec);
    const value = getPath(spec, field.path);
    return typeof value === "number" ? value : null;
  }

  function recommendedUsers(product) {
    const spec = productSpec(product);
    const values = [];
    const totalFreezer = (spec.size?.freezerL || 0) + (spec.size?.independentFreezerL || 0);
    if (totalFreezer >= 110 || freezerRatio(spec) >= 25 || isAvailable(spec.freezing?.mealPrep)) values.push("冷凍食品・作り置きを多く保存する人");
    if (isAvailable(spec.meatFish?.freshness)) values.push("肉・魚をまとめ買いする人");
    if ((spec.size?.vegetableL || 0) >= 100 || isAvailable(spec.vegetables?.freshness)) values.push("野菜をよく購入する人");
    if (spec.size?.widthMm <= 600) values.push("設置幅を抑えたい人");
    if (spec.size?.depthMm <= 650) values.push("キッチンの出っ張りを抑えたい人");
    if (spec.energy?.annualKwh <= 270) values.push("年間消費電力量を重視する人");
    if (spec.size?.totalL >= 600) values.push("大容量が必要な家庭");
    if (isAvailable(spec.meatFish?.noThawCooking) || isAvailable(spec.freezing?.cookFrozen)) values.push("解凍・下ごしらえの手間を減らしたい人");
    if (isAvailable(spec.smart?.app)) values.push("スマホ連携を活用したい人");
    return [...new Set(values)].slice(0, 4);
  }

  function productStrengths(product, comparedItems) {
    const spec = productSpec(product);
    const strengths = [];
    if (comparedItems.length > 1) {
      const candidates = [
        { field: "size.totalL", label: "総容量", direction: "higher", unit: "L" },
        { field: "size.freezerL", label: "冷凍室容量", direction: "higher", unit: "L", add: "size.independentFreezerL" },
        { field: "size.vegetableL", label: "野菜室容量", direction: "higher", unit: "L" },
        { field: "size.widthMm", label: "本体幅", direction: "lower", unit: "mm" },
        { field: "energy.annualKwh", label: "年間消費電力量", direction: "lower", unit: "kWh/年" }
      ];
      for (const candidate of candidates) {
        const own = comparableNumber(productSpec(product), candidate);
        const all = comparedItems.map((item) => comparableNumber(productSpec(item), candidate)).filter(Number.isFinite);
        if (!Number.isFinite(own) || all.length < 2 || new Set(all).size < 2) continue;
        const best = candidate.direction === "lower" ? Math.min(...all) : Math.max(...all);
        if (own === best) strengths.push(`比較中で${candidate.label}${candidate.direction === "lower" ? "が最小" : "が最大"}（${formatNumber(own)}${candidate.unit}）`);
      }
    }
    if (isAvailable(spec.meatFish?.noThawCooking) || isAvailable(spec.freezing?.cookFrozen)) strengths.push("解凍の手間を抑えやすい保存機能あり");
    if (spec.layout?.centerFreezer) strengths.push("冷凍室が真ん中で出し入れしやすい構成");
    if (spec.layout?.centerVegetable) strengths.push("野菜室が真ん中で出し入れしやすい構成");
    if (isAvailable(spec.freezing?.frostControl)) strengths.push("霜つき抑制系の冷凍機能あり");
    if (isAvailable(spec.smart?.app)) strengths.push("メーカー公式アプリ連携に対応");
    return [...new Set(strengths)].slice(0, 3);
  }

  function comparableNumber(spec, candidate) {
    const base = getPath(spec, candidate.field);
    if (!Number.isFinite(base)) return null;
    return base + (candidate.add ? (getPath(spec, candidate.add) || 0) : 0);
  }

  function sourceTrace(product) {
    const source = productSpec(product).source;
    if (!source?.sourceId) return unknownValue();
    const catalog = byCatalogSource[source.sourceId];
    return `<span class="source-trace"><strong>${escapeHtml(catalog?.label || source.sourceId)}</strong>${source.pages ? `<small>確認ページ: ${escapeHtml(source.pages)}</small>` : ""}</span>`;
  }

  function openDetail(productId) {
    const product = byProduct[productId];
    if (!product) return;
    detailProductId = productId;
    elements.detailDialogContent.innerHTML = detailTemplate(product);
    if (typeof elements.detailDialog.showModal === "function") {
      elements.detailDialog.showModal();
      elements.detailDialog.querySelector("[data-close-dialog]")?.focus();
    } else {
      elements.detailDialog.setAttribute("open", "");
    }
  }

  function closeDetail() {
    if (typeof elements.detailDialog.close === "function") elements.detailDialog.close();
    else elements.detailDialog.removeAttribute("open");
  }

  function detailTemplate(product) {
    const maker = byMaker[product.makerId];
    const spec = productSpec(product);
    const selected = state.compare.includes(product.id);
    const knownFields = (comparison.fields || []).filter((field) => !["recommended", "strengths", "cautions", "sourceTrace"].includes(field.type) && comparableValue(field, product) !== "unknown" && comparableValue(field, product) !== "null");
    const usedSources = [...new Set([...(product.sourceIds || []), ...(product.features || []).flatMap((feature) => feature.sourceIds || [])])].map((id) => bySource[id]).filter(Boolean);

    return `<article class="catalog-record" style="--accent:${safeColor(maker.accent)}">
      <header class="catalog-record-head"><p class="kicker">${escapeHtml(maker.name)} / ${escapeHtml(product.grade || app.itemLabel)}</p><h2 id="detailDialogTitle">${escapeHtml(product.name)}</h2>${product.talk ? `<p>${escapeHtml(product.talk)}</p>` : ""}</header>
      <dl class="catalog-fields">
        ${catalogField("発売時期", spec.basic?.release || product.model || "未確認")}
        ${catalogField("容量", spec.size?.totalL != null ? `${spec.size.totalL}L` : "未確認")}
        ${catalogField("本体幅", spec.size?.widthMm != null ? `${spec.size.widthMm}mm` : "未確認")}
        ${catalogField("ドア方式", spec.basic?.doorType || "未確認")}
        ${catalogField("レイアウト", spec.layout?.centerFreezer ? "真ん中冷凍" : spec.layout?.centerVegetable ? "真ん中野菜" : "標準")}
        ${catalogField("比較中", selected ? "追加済み" : "未追加")}
      </dl>
      <section class="catalog-section sales-detail"><h3>接客用 売り分け</h3><div class="sales-detail-grid"><div><h4>おすすめユーザー</h4>${inlineList(recommendedUsers(product))}</div><div><h4>主な強み</h4>${inlineList(productStrengths(product, []))}</div><div><h4>注意点</h4>${inlineList(product.cautions || [])}</div></div></section>
      <section class="catalog-section"><h3>正規化スペック <span class="feature-count">確認済み${knownFields.length}項目</span></h3><div class="normalized-spec-groups">${(comparison.groups || []).map((group) => {
        const fields = knownFields.filter((field) => field.groupId === group.id);
        if (!fields.length) return "";
        return `<details><summary>${escapeHtml(group.label)} <small>${fields.length}項目</small></summary><dl>${fields.map((field) => `<div><dt>${renderFieldLabel(field)}</dt><dd>${renderFieldValue(field, product)}</dd></div>`).join("")}</dl></details>`;
      }).join("")}</div></section>
      ${(product.features || []).length ? `<section class="catalog-section"><h3>メーカー機能・特徴 <span class="feature-count">${product.features.length}件</span></h3><div class="feature-list">${featureGroups.map((group) => {
        const features = product.features.filter((feature) => feature.groupId === group.id);
        return features.length ? `<section class="feature-group"><h4 class="feature-genre">${escapeHtml(group.label)}</h4><div class="feature-items">${features.map(featureTemplate).join("")}</div></section>` : "";
      }).join("")}</div></section>` : ""}
      <section class="catalog-section"><h3>情報源</h3>${sourceTrace(product)}${usedSources.length ? `<ul class="source-list">${usedSources.map(sourceTemplate).join("")}</ul>` : ""}</section>
      <div class="resource-actions"><button class="compare-button${selected ? " is-selected" : ""}" type="button" data-compare-id="${escapeAttr(product.id)}" ${!selected && state.compare.length >= compareLimit ? "disabled" : ""}>${selected ? "比較から外す" : "比較に追加"}</button></div>
    </article>`;
  }

  function catalogField(label, value) {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  }

  function featureTemplate(feature) {
    return `<details class="feature-tip"><summary><span>${escapeHtml(feature.name)}</span></summary>${feature.description ? `<p>${escapeHtml(feature.description)}</p>` : ""}</details>`;
  }

  function sourceTemplate(source) {
    const label = escapeHtml(source.label || source.id);
    return /^https?:\/\//i.test(source.url || "")
      ? `<li><a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${label}</a></li>`
      : `<li>${label}</li>`;
  }

  function renderMakerGuide() {
    elements.makerGuide.innerHTML = makers.map((maker) => `<article class="maker-card" style="--accent:${safeColor(maker.accent)}"><div class="maker-logo">${maker.logo ? `<img src="${escapeAttr(maker.logo)}" alt="${escapeAttr(maker.name)} ロゴ" />` : ""}<span class="media-fallback"${maker.logo ? " hidden" : ""}>${escapeHtml(maker.name)}</span></div><div class="maker-copy"><h3>${escapeHtml(maker.name)}</h3><p>${escapeHtml(maker.guide || "売り分け情報は準備中です。")}</p><a href="#results" data-maker-link="${escapeAttr(maker.id)}">このメーカーに絞る</a></div></article>`).join("");
  }

  function updateCompareCounts() {
    document.querySelectorAll("[data-compare-count]").forEach((element) => { element.textContent = state.compare.length; });
    document.querySelector(".compare-fab")?.setAttribute("aria-label", `比較リストへ移動、${state.compare.length}/${compareLimit}件を選択中`);
  }

  function productSpec(product) {
    return comparison.productSpecs?.[typeof product === "string" ? product : product.id] || {};
  }

  function productYear(product) {
    const release = productSpec(product).basic?.release || product.model || "";
    return String(release).match(/(2025|2026)年/)?.[1] || "";
  }

  function freezerRatio(spec) {
    const total = spec.size?.totalL;
    const freezer = spec.size?.freezerL;
    if (!Number.isFinite(total) || !Number.isFinite(freezer) || total <= 0) return null;
    return ((freezer + (spec.size?.independentFreezerL || 0)) / total) * 100;
  }

  function isAvailable(value) {
    return value?.available === true;
  }

  function getPath(object, path) {
    if (!path) return undefined;
    return path.split(".").reduce((value, key) => value?.[key], object);
  }

  function inlineList(values) {
    if (!values?.length) return unknownValue();
    return `<ul class="summary-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
  }

  function moveTo(id) {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
  }

  function normalize(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, " ").trim();
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value);
  }

  function safeColor(value) {
    return /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#006f6f";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
