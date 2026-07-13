/**
 * TradingCalendar.gs — 営業日判定(土日 + 日本の祝日)
 *
 * 祝日(株式休場日)は J-Quants /markets/trading_calendar から取得し、
 * スクリプトプロパティに30日キャッシュする。
 * API未設定 / 不通 / パース失敗時は「土日のみ判定」に自動縮退する(フェイルオープン:
 * 判定不能でも配信を止めない = 従来挙動)。
 *
 * 純粋関数(*Core / isWeekend / isBusinessDivision)は holidaySet を引数で受け取り、
 * tests/logic.test.js で検証する(GAS API非依存)。
 *
 * 依存: fmtYmd(Code.gs) / jqGet(JQuants.gs)
 */

// ---------- 純粋関数(テスト対象) ----------

/** 土日か @param {Date} date */
function isWeekend(date) {
  const g = date.getDay(); // 0=日, 6=土
  return g === 0 || g === 6;
}

/**
 * J-Quants HolidayDivision が営業日か
 * '1'=営業日, '2'=東証半日立会日(営業日扱い), '0'=非営業日, '3'=非営業日(OSE祝日取引)
 * @param {string|number} div
 */
function isBusinessDivision(div) {
  const s = String(div);
  return s === '1' || s === '2';
}

/**
 * その日が営業日か(純粋関数)
 * @param {Date} date
 * @param {Set<string>|null} holidaySet 'yyyy-MM-dd' の非営業日集合。
 *        null/未指定なら土日のみで判定(祝日データ無し時のフェイルオープン)
 * @return {boolean}
 */
function isBusinessDayJPCore(date, holidaySet) {
  if (isWeekend(date)) return false;
  if (holidaySet && holidaySet.has(fmtYmd(date))) return false;
  return true;
}

/**
 * 直前の営業日を返す(純粋関数)
 * @param {Date} date 起点(この日は含めず、前日以前で最初の営業日)
 * @param {Set<string>|null} holidaySet
 * @return {Date}
 */
function prevBusinessDayJPCore(date, holidaySet) {
  const x = new Date(date);
  do { x.setDate(x.getDate() - 1); } while (!isBusinessDayJPCore(x, holidaySet));
  return x;
}

// ---------- 本番ラッパー(祝日キャッシュを参照) ----------

/** その日が営業日か(本番用) @param {Date} date */
function isBusinessDayJP(date) {
  return isBusinessDayJPCore(date, getJpHolidaySet());
}

/** 直前の営業日(本番用) @param {Date} date */
function prevBusinessDayJP(date) {
  return prevBusinessDayJPCore(date, getJpHolidaySet());
}

// ---------- 祝日データ取得(J-Quants + キャッシュ) ----------

/**
 * 非営業日(株式休場日)の集合を返す。30日キャッシュ。
 * 取得不可時は古いキャッシュ→無ければ null を返し、呼び出し側は土日のみ判定に縮退する。
 * @return {Set<string>|null}
 */
function getJpHolidaySet() {
  try {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const exp = Number(props.getProperty('JQ_CAL_EXP') || 0);
    const cached = props.getProperty('JQ_CAL_HOLIDAYS');
    if (cached && now < exp) return new Set(JSON.parse(cached));

    const holidays = jqNonBusinessDays();
    if (holidays == null) {
      // 取得失敗: 期限切れでも古いキャッシュがあれば使う。無ければ null(=土日のみ)
      return cached ? new Set(JSON.parse(cached)) : null;
    }
    props.setProperty('JQ_CAL_HOLIDAYS', JSON.stringify(holidays));
    props.setProperty('JQ_CAL_EXP', String(now + 30 * 86400000)); // 30日
    return new Set(holidays);
  } catch (e) {
    Logger.log('getJpHolidaySet error: ' + e);
    return null;
  }
}

/**
 * J-Quants取引カレンダーから非営業日の 'yyyy-MM-dd' 配列を返す。
 * 直近30日前〜約400日先を取得。
 * @return {Array<string>|null} null は取得不可(J-Quants未設定/不通/形式不正)
 */
function jqNonBusinessDays() {
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 86400000);
  const to = new Date(today.getTime() + 400 * 86400000);
  const j = jqGet('/markets/trading_calendar', { from: fmtYmd(from), to: fmtYmd(to) });
  if (!j || !Array.isArray(j.trading_calendar)) return null;
  return j.trading_calendar
    .filter(r => !isBusinessDivision(r.HolidayDivision))
    .map(r => r.Date);
}
