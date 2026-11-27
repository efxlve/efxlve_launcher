import { afterEach, describe, expect, it } from "vitest";
import { S } from "../../core/state";
import { currentFocusedEl, moveGamepadFocus, setFocus } from "./focus-engine";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function setBox(el: HTMLElement, box: Box): HTMLElement {
  const rect = {
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect;
  el.getBoundingClientRect = () => rect;
  return el;
}

function buildLibraryDom(opts: {
  withSidebar?: boolean;
  withCouchBar?: boolean;
  topRowCount?: number;
  secondRowCount?: number;
  withCollectionBanner?: boolean;
  withOpenStoreDropdown?: boolean;
} = {}) {
  const {
    withSidebar = true,
    withCouchBar = false,
    topRowCount = 6,
    secondRowCount = 6,
    withCollectionBanner = false,
    withOpenStoreDropdown = false,
  } = opts;

  document.body.innerHTML = "";
  S.view = "library";
  S.currentModalAppName = null;

  const sidebar = document.createElement("aside");
  sidebar.id = "sidebar";
  const sbLibrary = setBox(document.createElement("button"), {
    left: 10,
    top: 210,
    width: 50,
    height: 36,
  });
  sbLibrary.className = "sb-item active";
  sbLibrary.dataset.view = "library";
  if (withSidebar) {
    sidebar.appendChild(sbLibrary);
  }
  document.body.appendChild(sidebar);

  let couchLibrary: HTMLButtonElement | null = null;
  if (withCouchBar) {
    const bar = document.createElement("header");
    bar.id = "couch-bar";
    couchLibrary = setBox(document.createElement("button"), {
      left: 220,
      top: 12,
      width: 110,
      height: 40,
    }) as HTMLButtonElement;
    couchLibrary.className = "couch-nav-item active";
    couchLibrary.dataset.gpItem = "";
    couchLibrary.dataset.couchView = "library";
    bar.appendChild(couchLibrary);
    document.body.appendChild(bar);
  }

  const pageHeader = document.createElement("header");
  pageHeader.id = "page-header";
  const headerFilters = setBox(document.createElement("button"), {
    left: 1060,
    top: 48,
    width: 80,
    height: 32,
  });
  headerFilters.dataset.act = "toggle-lib-filters";
  const headerSearch = setBox(document.createElement("button"), {
    left: 1150,
    top: 48,
    width: 120,
    height: 32,
  });
  headerSearch.dataset.act = "open-palette";
  pageHeader.append(headerFilters, headerSearch);
  document.body.appendChild(pageHeader);

  const content = document.createElement("main");
  content.id = "content";
  const view = document.createElement("section");
  view.id = "view";
  const libPage = document.createElement("div");
  libPage.className = "page lib-page";

  // Library filter & tool bar (.lib-head)
  const libHead = document.createElement("div");
  libHead.className = "lib-head";
  const libFilters = document.createElement("div");
  libFilters.className = "tabs lib-filters";

  const tabAll = setBox(document.createElement("button"), { left: 90, top: 100, width: 42, height: 48 });
  tabAll.className = "tab lib-filter";
  tabAll.dataset.act = "quick-tab";
  tabAll.dataset.tab = "all";

  const tabInstalled = setBox(document.createElement("button"), { left: 145, top: 100, width: 72, height: 48 });
  tabInstalled.className = "tab lib-filter active";
  tabInstalled.dataset.act = "quick-tab";
  tabInstalled.dataset.tab = "installed";

  const tabFav = setBox(document.createElement("button"), { left: 230, top: 100, width: 76, height: 48 });
  tabFav.className = "tab lib-filter";
  tabFav.dataset.act = "quick-tab";
  tabFav.dataset.tab = "favorites";

  const tabCols = setBox(document.createElement("button"), { left: 320, top: 100, width: 96, height: 48 });
  tabCols.className = "tab lib-filter lib-col-dropdown-btn";
  tabCols.dataset.act = "toggle-col-dropdown";

  libFilters.append(tabAll, tabInstalled, tabFav, tabCols);

  const libTools = document.createElement("div");
  libTools.className = "lib-tools";

  const storeContainer = document.createElement("div");
  storeContainer.className = "store-dropdown-container";
  const storeBtn = setBox(document.createElement("button"), { left: 940, top: 104, width: 120, height: 40 });
  storeBtn.className = "btn lib-sort-btn lib-store-btn";
  storeBtn.dataset.act = "toggle-store-dropdown";
  storeContainer.appendChild(storeBtn);

  let storeOptAll: HTMLButtonElement | null = null;
  let storeOptEpic: HTMLButtonElement | null = null;
  if (withOpenStoreDropdown) {
    const menu = document.createElement("div");
    menu.id = "store-dropdown-menu";
    menu.className = "sort-dropdown-menu store-dropdown-menu show";
    storeOptAll = setBox(document.createElement("button"), {
      left: 840,
      top: 152,
      width: 220,
      height: 32,
    }) as HTMLButtonElement;
    storeOptAll.dataset.act = "source-filter";
    storeOptAll.dataset.val = "all";
    storeOptEpic = setBox(document.createElement("button"), {
      left: 840,
      top: 186,
      width: 220,
      height: 32,
    }) as HTMLButtonElement;
    storeOptEpic.dataset.act = "source-filter";
    storeOptEpic.dataset.val = "epic";
    menu.append(storeOptAll, storeOptEpic);
    storeContainer.appendChild(menu);
  }

  const sortBtn = setBox(document.createElement("button"), { left: 1070, top: 104, width: 130, height: 40 });
  sortBtn.className = "btn lib-sort-btn lib-sort-trigger";
  sortBtn.dataset.act = "toggle-sort-dropdown";

  const refreshBtn = setBox(document.createElement("button"), { left: 1210, top: 104, width: 40, height: 40 });
  refreshBtn.className = "icon-btn lib-refresh-btn";
  refreshBtn.dataset.act = "epic-refresh";

  libTools.append(storeContainer, sortBtn, refreshBtn);
  libHead.append(libFilters, libTools);
  libPage.appendChild(libHead);

  const results = document.createElement("div");
  results.id = "lib-results";

  let bannerClear: HTMLButtonElement | null = null;
  if (withCollectionBanner) {
    const banner = document.createElement("div");
    banner.className = "lib-collection-banner";
    bannerClear = setBox(document.createElement("button"), {
      left: 1170,
      top: 162,
      width: 80,
      height: 32,
    }) as HTMLButtonElement;
    bannerClear.dataset.act = "select-col-filter";
    banner.appendChild(bannerClear);
    results.appendChild(banner);
  }

  const pgrid = document.createElement("div");
  pgrid.className = "pgrid";
  const topOffset = withCollectionBanner ? 210 : 166;
  const colWidth = 175;
  const colGap = 18;
  const rowHeight = 255;
  const rowGap = 20;

  const makeCard = (id: string, row: number, col: number): HTMLElement => {
    const card = setBox(document.createElement("div"), {
      left: 90 + col * (colWidth + colGap),
      top: topOffset + row * (rowHeight + rowGap),
      width: colWidth,
      height: rowHeight,
    });
    card.className = "pcard";
    card.dataset.act = "epic-detail";
    card.dataset.id = id;
    card.dataset.libItem = id;
    return card;
  };

  const row1: HTMLElement[] = [];
  for (let c = 0; c < topRowCount; c++) {
    const card = makeCard(`r1c${c}`, 0, c);
    row1.push(card);
    pgrid.appendChild(card);
  }

  const row2: HTMLElement[] = [];
  for (let c = 0; c < secondRowCount; c++) {
    const card = makeCard(`r2c${c}`, 1, c);
    row2.push(card);
    pgrid.appendChild(card);
  }

  results.appendChild(pgrid);
  libPage.appendChild(results);
  view.appendChild(libPage);
  content.appendChild(view);
  document.body.appendChild(content);

  return {
    sbLibrary,
    couchLibrary,
    headerFilters,
    headerSearch,
    tabAll,
    tabInstalled,
    tabFav,
    tabCols,
    storeBtn,
    storeOptAll,
    storeOptEpic,
    sortBtn,
    refreshBtn,
    bannerClear,
    row1,
    row2,
  };
}

describe("gamepad focus engine library navigation", () => {
  afterEach(() => {
    setFocus(null);
    document.body.innerHTML = "";
  });

  it("never jumps from the top row into filters or store filters when moving left or right", () => {
    const ui = buildLibraryDom({ withSidebar: false, topRowCount: 6, secondRowCount: 6 });

    // Walk across the entire top row rightwards and keep pressing Right past the last card.
    setFocus(ui.row1[0]);
    for (let i = 1; i < ui.row1.length; i++) {
      moveGamepadFocus("right");
      expect(currentFocusedEl).toBe(ui.row1[i]);
    }
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.row1[5]);

    // Walk back leftwards and press Left past the first card (no sidebar in fullscreen).
    for (let i = ui.row1.length - 2; i >= 0; i--) {
      moveGamepadFocus("left");
      expect(currentFocusedEl).toBe(ui.row1[i]);
    }
    moveGamepadFocus("left");
    expect(currentFocusedEl).toBe(ui.row1[0]);
  });

  it("never jumps into store filters on a short top row or into collection banner controls", () => {
    const ui = buildLibraryDom({
      withSidebar: false,
      topRowCount: 3,
      secondRowCount: 0,
      withCollectionBanner: true,
    });

    setFocus(ui.row1[2]);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.row1[2]);
  });

  it("moves from the first card to the sidebar instead of the filter tabs when sidebar is visible", () => {
    const ui = buildLibraryDom({ withSidebar: true, topRowCount: 6, secondRowCount: 6 });

    setFocus(ui.row1[0]);
    moveGamepadFocus("left");
    expect(currentFocusedEl).toBe(ui.sbLibrary);
  });

  it("keeps incomplete second row right-edge presses from jumping up to row 1", () => {
    const ui = buildLibraryDom({ withSidebar: false, topRowCount: 6, secondRowCount: 2 });

    setFocus(ui.row2[1]);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.row2[1]);
  });

  it("climbs cleanly with Up from row 1 to filters/tools and returns with Down", () => {
    const ui = buildLibraryDom({
      withSidebar: false,
      withCouchBar: true,
      topRowCount: 6,
      secondRowCount: 6,
    });

    setFocus(ui.row1[0]);
    moveGamepadFocus("up");
    expect([ui.tabAll, ui.tabInstalled]).toContain(currentFocusedEl);

    // Horizontal navigation inside the library toolbar walks tabs -> store/sort -> refresh.
    setFocus(ui.tabAll);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.tabInstalled);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.tabFav);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.tabCols);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.storeBtn);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.sortBtn);
    moveGamepadFocus("right");
    expect(currentFocusedEl).toBe(ui.refreshBtn);

    // Down from the toolbar returns to the card grid.
    moveGamepadFocus("down");
    expect(currentFocusedEl).toBe(ui.row1[5]);

    // Up from the left side of the toolbar reaches the couch bar instead of jumping to far-right header search.
    setFocus(ui.tabAll);
    moveGamepadFocus("up");
    expect(currentFocusedEl).toBe(ui.couchLibrary);
  });

  it("walks down into an open store dropdown menu from the store filter button", () => {
    const ui = buildLibraryDom({
      withSidebar: true,
      topRowCount: 6,
      secondRowCount: 0,
      withOpenStoreDropdown: true,
    });

    setFocus(ui.storeBtn);
    moveGamepadFocus("down");
    expect(currentFocusedEl).toBe(ui.storeOptAll);
    moveGamepadFocus("down");
    expect(currentFocusedEl).toBe(ui.storeOptEpic);
    // Left inside the dropdown must stay inside the dropdown instead of fleeing to sidebar.
    moveGamepadFocus("left");
    expect(currentFocusedEl).toBe(ui.storeOptEpic);
    moveGamepadFocus("up");
    expect(currentFocusedEl).toBe(ui.storeOptAll);
    moveGamepadFocus("up");
    expect(currentFocusedEl).toBe(ui.storeBtn);
  });
});
