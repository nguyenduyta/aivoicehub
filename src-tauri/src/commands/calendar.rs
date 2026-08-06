//! Calendar subscription — reads Google Calendar (and any RFC 5545 feed) over iCal/ICS
//! and turns it into a list of upcoming meetings with their video-conference links.
//!
//! # Why ICS and not the Google Calendar API
//!
//! A subscribed feed needs no OAuth client registration, no consent screen, and no refresh
//! tokens: the user pastes the calendar's *secret address in iCal format* and it works. The
//! `calendar_source` setting is kept in the schema so an OAuth backend can be added later
//! without migrating anyone's `settings.json`.
//!
//! # Why the fetch lives in Rust
//!
//! Google serves these feeds without CORS headers, so fetching from the webview fails. The
//! request has to happen here.
//!
//! # Offline behaviour
//!
//! Every successful fetch is cached under `<app_data_dir>/calendar-cache/`. A failed refresh
//! falls back to the cached copy and reports the error per feed, so a network blip shows a
//! stale agenda rather than an empty one.

use crate::settings::{CalendarFeed, SettingsState};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
    Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

/// Upper bound on the day-by-day recurrence scan (~54 years). Guards against a malformed
/// RRULE turning into an unbounded loop.
const MAX_SCAN_DAYS: usize = 20_000;
/// Per-event cap on emitted occurrences inside the requested window.
const MAX_OCCURRENCES: usize = 400;
/// A meeting that started up to this long ago still appears, so you can join one in progress.
const LOOKBACK_HOURS: i64 = 12;

// ════════════════════════════════════════════════════════════════════════════
// Public shapes (IPC)
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub uid: String,
    /// Label of the feed this came from.
    pub calendar: String,
    pub title: String,
    /// Epoch milliseconds (UTC).
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub location: String,
    pub description: String,
    /// Best conference link found, or empty.
    pub meeting_url: String,
    /// "meet" | "zoom" | "teams" | "webex" | "other" | ""
    pub meeting_kind: String,
    pub organizer: String,
    pub attendee_count: usize,
    /// True when this instance came from an RRULE expansion.
    pub recurring: bool,
    /// True when the RRULE used a part this parser does not implement, so the time may be off.
    pub approximate: bool,
    /// "CONFIRMED" | "TENTATIVE" | "CANCELLED" | ""
    pub status: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub label: String,
    pub url: String,
    pub ok: bool,
    pub error: String,
    /// Epoch ms of the data actually used (cache or fresh).
    pub fetched_at: i64,
    pub from_cache: bool,
    pub event_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarResult {
    pub events: Vec<CalendarEvent>,
    pub feeds: Vec<FeedStatus>,
    /// Window actually covered, epoch ms.
    pub window_start: i64,
    pub window_end: i64,
    /// Warnings worth surfacing (unsupported RRULE parts, unknown TZIDs…).
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetEventsArgs {
    /// Force a network fetch. When false, a cache newer than `calendar_refresh_minutes` is reused.
    #[serde(default)]
    pub refresh: Option<bool>,
    /// Override `calendar_days_ahead` for this call.
    #[serde(default)]
    pub days_ahead: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestFeedResult {
    pub ok: bool,
    pub calendar_name: String,
    pub event_count: usize,
    pub upcoming_count: usize,
    pub error: String,
}

// ════════════════════════════════════════════════════════════════════════════
// ICS lexing
// ════════════════════════════════════════════════════════════════════════════

/// One unfolded `NAME;PARAM=v:value` line.
#[derive(Debug, Clone)]
struct ContentLine {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl ContentLine {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
}

/// Undo RFC 5545 line folding: a CRLF followed by a space or tab continues the previous line.
fn unfold(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw_line in raw.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        let is_continuation = line.starts_with(' ') || line.starts_with('\t');
        if is_continuation {
            if let Some(last) = out.last_mut() {
                last.push_str(&line[1..]);
                continue;
            }
        }
        out.push(line.to_string());
    }
    out
}

/// Split a content line into name, params and value.
///
/// The name/value separator is the first `:` that is **not** inside a quoted parameter value —
/// `ATTENDEE;CN="Doe, J:r":mailto:x@y` would otherwise split in the wrong place.
fn parse_content_line(line: &str) -> Option<ContentLine> {
    let bytes = line.as_char_indices_vec();
    let mut in_quotes = false;
    let mut colon_at = None;
    for (idx, ch) in bytes.iter().copied() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon_at = Some(idx);
                break;
            }
            _ => {}
        }
    }
    let colon_at = colon_at?;
    let (head, value) = (&line[..colon_at], &line[colon_at + 1..]);

    // Params are separated by unquoted ';'
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in head.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(ch);
            }
            ';' if !in_quotes => {
                parts.push(std::mem::take(&mut cur));
            }
            _ => cur.push(ch),
        }
    }
    parts.push(cur);

    let mut iter = parts.into_iter();
    let name = iter.next()?.trim().to_uppercase();
    let params = iter
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            let v = v.trim().trim_matches('"').to_string();
            Some((k.trim().to_uppercase(), v))
        })
        .collect();

    Some(ContentLine {
        name,
        params,
        value: value.to_string(),
    })
}

/// Helper so `parse_content_line` can index by byte offset while iterating chars.
trait CharIndicesVec {
    fn as_char_indices_vec(&self) -> Vec<(usize, char)>;
}
impl CharIndicesVec for str {
    fn as_char_indices_vec(&self) -> Vec<(usize, char)> {
        self.char_indices().collect()
    }
}

/// Unescape an ICS TEXT value: `\n` `\N` → newline, `\,` `\;` `\\` → literal.
fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

// ════════════════════════════════════════════════════════════════════════════
// Time handling
// ════════════════════════════════════════════════════════════════════════════

/// Which zone a wall-clock value should be interpreted in.
#[derive(Debug, Clone, Copy)]
enum Zone {
    Named(Tz),
    /// Floating time or all-day date — interpret in the viewer's zone.
    Local,
}

/// Resolve a wall-clock time to an absolute instant.
///
/// DST edge cases: a time that occurs twice (fall back) takes the earlier instant; a time that
/// does not exist (spring forward) is nudged forward an hour rather than dropped.
fn resolve_instant(zone: Zone, naive: NaiveDateTime, default_tz: Option<Tz>) -> DateTime<Utc> {
    let zone = match zone {
        Zone::Local => match default_tz {
            Some(tz) => Zone::Named(tz),
            None => Zone::Local,
        },
        z => z,
    };

    match zone {
        Zone::Named(tz) => match tz.from_local_datetime(&naive) {
            LocalResult::Single(dt) => dt.with_timezone(&Utc),
            LocalResult::Ambiguous(a, _) => a.with_timezone(&Utc),
            LocalResult::None => tz
                .from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&naive)),
        },
        Zone::Local => match chrono::Local.from_local_datetime(&naive) {
            LocalResult::Single(dt) => dt.with_timezone(&Utc),
            LocalResult::Ambiguous(a, _) => a.with_timezone(&Utc),
            LocalResult::None => chrono::Local
                .from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&naive)),
        },
    }
}

/// A parsed DATE / DATE-TIME property.
#[derive(Debug, Clone, Copy)]
struct IcsMoment {
    naive: NaiveDateTime,
    zone: Zone,
    all_day: bool,
}

/// Parse `20260806T100000Z`, `20260806T100000` or `20260806`.
///
/// Three forms with three different meanings — reading a `TZID` value as UTC (or vice versa)
/// shifts the whole day's agenda, which is why the zone is carried alongside the wall clock
/// instead of being collapsed to an instant here.
fn parse_moment(line: &ContentLine, warnings: &mut Vec<String>) -> Option<IcsMoment> {
    let raw = line.value.trim();
    let is_date_only = line
        .param("VALUE")
        .map(|v| v.eq_ignore_ascii_case("DATE"))
        .unwrap_or(false)
        || (raw.len() == 8 && !raw.contains('T'));

    if is_date_only {
        let d = NaiveDate::parse_from_str(raw, "%Y%m%d").ok()?;
        return Some(IcsMoment {
            naive: d.and_time(NaiveTime::MIN),
            zone: Zone::Local,
            all_day: true,
        });
    }

    let (body, is_utc) = match raw.strip_suffix('Z') {
        Some(b) => (b, true),
        None => (raw, false),
    };
    let naive = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M"))
        .ok()?;

    let zone = if is_utc {
        Zone::Named(Tz::UTC)
    } else if let Some(tzid) = line.param("TZID") {
        match tzid.parse::<Tz>() {
            Ok(tz) => Zone::Named(tz),
            Err(_) => {
                let w = format!("Unknown TZID '{}' — using local time", tzid);
                if !warnings.contains(&w) {
                    warnings.push(w);
                }
                Zone::Local
            }
        }
    } else {
        Zone::Local
    };

    Some(IcsMoment {
        naive,
        zone,
        all_day: false,
    })
}

/// Parse an RFC 5545 DURATION such as `PT1H30M`, `P1D`, `-PT15M`.
fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1i64, r),
        None => (1i64, s.strip_prefix('+').unwrap_or(s)),
    };
    let rest = rest.strip_prefix('P')?;
    let (date_part, time_part) = match rest.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (rest, None),
    };

    let mut secs: i64 = 0;
    let mut num = String::new();
    for ch in date_part.chars() {
        if ch.is_ascii_digit() {
            num.push(ch);
            continue;
        }
        let n: i64 = num.parse().unwrap_or(0);
        num.clear();
        match ch {
            'W' => secs += n * 7 * 86400,
            'D' => secs += n * 86400,
            _ => return None,
        }
    }
    if let Some(t) = time_part {
        let mut num = String::new();
        for ch in t.chars() {
            if ch.is_ascii_digit() {
                num.push(ch);
                continue;
            }
            let n: i64 = num.parse().unwrap_or(0);
            num.clear();
            match ch {
                'H' => secs += n * 3600,
                'M' => secs += n * 60,
                'S' => secs += n,
                _ => return None,
            }
        }
    }
    Some(Duration::seconds(sign * secs))
}

// ════════════════════════════════════════════════════════════════════════════
// RRULE
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
struct RRule {
    freq: Freq,
    interval: i64,
    count: Option<u32>,
    until: Option<DateTime<Utc>>,
    /// (nth occurrence in period, weekday). `nth == None` means "every".
    by_day: Vec<(Option<i32>, Weekday)>,
    by_month_day: Vec<i32>,
    by_month: Vec<u32>,
    wkst: Weekday,
    /// Parts this implementation ignores — surfaced as `approximate` on the event.
    unsupported: Vec<String>,
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    match s.to_uppercase().as_str() {
        "MO" => Some(Weekday::Mon),
        "TU" => Some(Weekday::Tue),
        "WE" => Some(Weekday::Wed),
        "TH" => Some(Weekday::Thu),
        "FR" => Some(Weekday::Fri),
        "SA" => Some(Weekday::Sat),
        "SU" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_rrule(value: &str, warnings: &mut Vec<String>) -> Option<RRule> {
    let mut freq = None;
    let mut rule = RRule {
        freq: Freq::Daily,
        interval: 1,
        count: None,
        until: None,
        by_day: Vec::new(),
        by_month_day: Vec::new(),
        by_month: Vec::new(),
        wkst: Weekday::Mon,
        unsupported: Vec::new(),
    };

    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        let k = k.trim().to_uppercase();
        let v = v.trim();
        match k.as_str() {
            "FREQ" => {
                freq = match v.to_uppercase().as_str() {
                    "DAILY" => Some(Freq::Daily),
                    "WEEKLY" => Some(Freq::Weekly),
                    "MONTHLY" => Some(Freq::Monthly),
                    "YEARLY" => Some(Freq::Yearly),
                    other => {
                        let w = format!("Unsupported RRULE FREQ={} — event shown once", other);
                        if !warnings.contains(&w) {
                            warnings.push(w);
                        }
                        None
                    }
                };
            }
            "INTERVAL" => rule.interval = v.parse::<i64>().unwrap_or(1).max(1),
            "COUNT" => rule.count = v.parse::<u32>().ok(),
            "UNTIL" => {
                let line = ContentLine {
                    name: "UNTIL".into(),
                    params: vec![],
                    value: v.to_string(),
                };
                let mut ignored = Vec::new();
                if let Some(m) = parse_moment(&line, &mut ignored) {
                    // A date-only UNTIL is inclusive of the whole day.
                    let naive = if m.all_day {
                        m.naive.date().and_time(
                            NaiveTime::from_hms_opt(23, 59, 59).unwrap_or(NaiveTime::MIN),
                        )
                    } else {
                        m.naive
                    };
                    rule.until = Some(resolve_instant(m.zone, naive, None));
                }
            }
            "BYDAY" => {
                for token in v.split(',') {
                    let token = token.trim();
                    if token.is_empty() {
                        continue;
                    }
                    let split = token
                        .find(|c: char| c.is_ascii_alphabetic())
                        .unwrap_or(token.len());
                    let (num, day) = token.split_at(split);
                    if let Some(wd) = parse_weekday(day) {
                        let nth = if num.is_empty() {
                            None
                        } else {
                            num.parse::<i32>().ok()
                        };
                        rule.by_day.push((nth, wd));
                    }
                }
            }
            "BYMONTHDAY" => {
                rule.by_month_day = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            }
            "BYMONTH" => {
                rule.by_month = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            }
            "WKST" => {
                if let Some(wd) = parse_weekday(v) {
                    rule.wkst = wd;
                }
            }
            "BYSETPOS" | "BYWEEKNO" | "BYYEARDAY" | "BYHOUR" | "BYMINUTE" | "BYSECOND" => {
                rule.unsupported.push(k.clone());
                let w = format!(
                    "RRULE {} is not implemented — some occurrences of a recurring meeting may be off",
                    k
                );
                if !warnings.contains(&w) {
                    warnings.push(w);
                }
            }
            _ => {}
        }
    }

    rule.freq = freq?;
    Some(rule)
}

/// Start of the week containing `d`, honouring WKST.
fn week_start(d: NaiveDate, wkst: Weekday) -> NaiveDate {
    let delta = (d.weekday().num_days_from_monday() as i64
        - wkst.num_days_from_monday() as i64
        + 7)
        % 7;
    d - Duration::days(delta)
}

/// Number of days in the month containing `d`.
fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap_or_default();
    let first_this = NaiveDate::from_ymd_opt(year, month, 1).unwrap_or_default();
    (first_next - first_this).num_days() as u32
}

/// Does `date` fall on this rule's recurrence pattern, given the series start?
fn rule_matches(rule: &RRule, start: NaiveDate, date: NaiveDate) -> bool {
    if date == start {
        return true; // DTSTART is always an occurrence.
    }
    if date < start {
        return false;
    }

    match rule.freq {
        Freq::Daily => (date - start).num_days() % rule.interval == 0,

        Freq::Weekly => {
            let ws_start = week_start(start, rule.wkst);
            let ws_date = week_start(date, rule.wkst);
            let weeks = (ws_date - ws_start).num_days() / 7;
            if weeks % rule.interval != 0 {
                return false;
            }
            if rule.by_day.is_empty() {
                date.weekday() == start.weekday()
            } else {
                rule.by_day.iter().any(|(_, wd)| *wd == date.weekday())
            }
        }

        Freq::Monthly => {
            let months = (date.year() as i64 - start.year() as i64) * 12
                + (date.month() as i64 - start.month() as i64);
            if months % rule.interval != 0 {
                return false;
            }
            month_day_matches(rule, start, date)
        }

        Freq::Yearly => {
            let years = date.year() as i64 - start.year() as i64;
            if years % rule.interval != 0 {
                return false;
            }
            let month_ok = if rule.by_month.is_empty() {
                date.month() == start.month()
            } else {
                rule.by_month.contains(&date.month())
            };
            month_ok && month_day_matches(rule, start, date)
        }
    }
}

/// Day-within-month test shared by MONTHLY and YEARLY.
fn month_day_matches(rule: &RRule, start: NaiveDate, date: NaiveDate) -> bool {
    if !rule.by_month_day.is_empty() {
        let dim = days_in_month(date.year(), date.month()) as i32;
        return rule.by_month_day.iter().any(|&md| {
            let target = if md < 0 { dim + md + 1 } else { md };
            target == date.day() as i32
        });
    }

    if !rule.by_day.is_empty() {
        return rule.by_day.iter().any(|(nth, wd)| {
            if date.weekday() != *wd {
                return false;
            }
            match nth {
                None => true,
                Some(n) if *n > 0 => {
                    // nth occurrence of this weekday in the month
                    let ordinal = (date.day() as i32 - 1) / 7 + 1;
                    ordinal == *n
                }
                Some(n) => {
                    // -1 = last, -2 = second to last …
                    let dim = days_in_month(date.year(), date.month()) as i32;
                    let from_end = (dim - date.day() as i32) / 7 + 1;
                    from_end == -*n
                }
            }
        });
    }

    date.day() == start.day()
}

// ════════════════════════════════════════════════════════════════════════════
// VEVENT model
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
struct VEvent {
    uid: String,
    title: String,
    description: String,
    location: String,
    conference: String,
    organizer: String,
    attendee_count: usize,
    status: String,
    start: IcsMoment,
    duration: Duration,
    rrule: Option<RRule>,
    /// Instants removed from the series.
    exdates: Vec<DateTime<Utc>>,
    /// Set when this VEVENT overrides one instance of a recurring series.
    recurrence_id: Option<DateTime<Utc>>,
}

fn extract_conference(description: &str, location: &str, x_conf: &str) -> (String, String) {
    // 1) The explicit property Google writes for Meet.
    let x = x_conf.trim();
    if !x.is_empty() {
        return (x.to_string(), classify_url(x));
    }
    // 2) LOCATION when it is itself a URL.
    let loc = location.trim();
    if loc.starts_with("http://") || loc.starts_with("https://") {
        let url = loc.split_whitespace().next().unwrap_or(loc).to_string();
        return (url.clone(), classify_url(&url));
    }
    // 3) Scan free text. Google often only puts the link in DESCRIPTION.
    for haystack in [location, description] {
        if let Some(found) = scan_conference_url(haystack) {
            let kind = classify_url(&found);
            return (found, kind);
        }
    }
    (String::new(), String::new())
}

/// Hand-rolled URL scanner — avoids pulling in `regex` for four known patterns.
fn scan_conference_url(text: &str) -> Option<String> {
    const HOSTS: [&str; 5] = [
        "meet.google.com/",
        "zoom.us/j/",
        "teams.microsoft.com/l/meetup-join/",
        "whereby.com/",
        "webex.com/meet/",
    ];
    let lower = text.to_lowercase();
    let mut best: Option<(usize, String)> = None;

    for host in HOSTS {
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(host) {
            let at = from + rel;
            // Walk back to the scheme if present.
            let start = lower[..at]
                .rfind("https://")
                .filter(|s| lower[*s..at].find(' ').is_none())
                .or_else(|| {
                    lower[..at]
                        .rfind("http://")
                        .filter(|s| lower[*s..at].find(' ').is_none())
                })
                .unwrap_or(at);
            // Walk forward while the char is URL-ish.
            let mut end = at + host.len();
            let bytes: Vec<(usize, char)> = text.char_indices().collect();
            for (idx, ch) in bytes.iter().copied() {
                if idx < end {
                    continue;
                }
                if ch.is_alphanumeric()
                    || matches!(ch, '-' | '_' | '.' | '/' | '?' | '=' | '&' | '%' | '+' | '~')
                {
                    end = idx + ch.len_utf8();
                } else {
                    break;
                }
            }
            let mut url = text[start..end].trim_end_matches(['.', ',', ')', '>']).to_string();
            if !url.starts_with("http") {
                url = format!("https://{}", url);
            }
            if best.as_ref().map(|(p, _)| at < *p).unwrap_or(true) {
                best = Some((at, url));
            }
            from = at + host.len();
        }
    }
    best.map(|(_, u)| u)
}

fn classify_url(url: &str) -> String {
    let l = url.to_lowercase();
    if l.contains("meet.google.com") {
        "meet"
    } else if l.contains("zoom.us") {
        "zoom"
    } else if l.contains("teams.microsoft.com") {
        "teams"
    } else if l.contains("webex.com") {
        "webex"
    } else {
        "other"
    }
    .to_string()
}

/// Pull VEVENTs out of an ICS document. Also returns `X-WR-CALNAME` when present.
fn parse_ics(raw: &str, warnings: &mut Vec<String>) -> (Vec<VEvent>, String) {
    let lines = unfold(raw);
    let mut events = Vec::new();
    let mut cal_name = String::new();
    let mut in_event = false;
    let mut depth_other = 0usize; // skip VTIMEZONE / VALARM bodies
    let mut props: Vec<ContentLine> = Vec::new();

    for line in &lines {
        let Some(cl) = parse_content_line(line) else {
            continue;
        };

        if cl.name == "BEGIN" {
            let comp = cl.value.trim().to_uppercase();
            if comp == "VEVENT" {
                in_event = true;
                props.clear();
                continue;
            }
            if in_event {
                depth_other += 1; // VALARM inside the event
            }
            continue;
        }
        if cl.name == "END" {
            let comp = cl.value.trim().to_uppercase();
            if comp == "VEVENT" {
                in_event = false;
                if let Some(ev) = build_event(&props, warnings) {
                    events.push(ev);
                }
                props.clear();
                continue;
            }
            if in_event && depth_other > 0 {
                depth_other -= 1;
            }
            continue;
        }

        if !in_event {
            if cl.name == "X-WR-CALNAME" {
                cal_name = unescape_text(&cl.value).trim().to_string();
            }
            continue;
        }
        if depth_other > 0 {
            continue; // inside VALARM
        }
        props.push(cl);
    }

    (events, cal_name)
}

fn build_event(props: &[ContentLine], warnings: &mut Vec<String>) -> Option<VEvent> {
    let find = |name: &str| props.iter().find(|p| p.name == name);
    let text = |name: &str| {
        find(name)
            .map(|p| unescape_text(&p.value).trim().to_string())
            .unwrap_or_default()
    };

    let dtstart_line = find("DTSTART")?;
    let start = parse_moment(dtstart_line, warnings)?;

    // End: DTEND, else DTSTART+DURATION, else 1 day for all-day / 0 otherwise.
    let duration = if let Some(dtend_line) = find("DTEND") {
        match parse_moment(dtend_line, warnings) {
            Some(end) => end.naive - start.naive,
            None => Duration::zero(),
        }
    } else if let Some(dur) = find("DURATION").and_then(|p| parse_duration(&p.value)) {
        dur
    } else if start.all_day {
        Duration::days(1)
    } else {
        Duration::zero()
    };

    let rrule = find("RRULE").and_then(|p| parse_rrule(&p.value, warnings));

    // EXDATE may repeat and may carry comma-separated values.
    let mut exdates = Vec::new();
    for p in props.iter().filter(|p| p.name == "EXDATE") {
        for token in p.value.split(',') {
            let line = ContentLine {
                name: "EXDATE".into(),
                params: p.params.clone(),
                value: token.trim().to_string(),
            };
            if let Some(m) = parse_moment(&line, warnings) {
                exdates.push(resolve_instant(m.zone, m.naive, None));
            }
        }
    }

    let recurrence_id = find("RECURRENCE-ID")
        .and_then(|p| parse_moment(p, warnings))
        .map(|m| resolve_instant(m.zone, m.naive, None));

    let x_conf = text("X-GOOGLE-CONFERENCE");
    let description = text("DESCRIPTION");
    let location = text("LOCATION");
    let (conference, _) = extract_conference(&description, &location, &x_conf);

    let organizer = find("ORGANIZER")
        .map(|p| {
            p.param("CN")
                .map(|s| s.to_string())
                .unwrap_or_else(|| p.value.trim_start_matches("mailto:").to_string())
        })
        .unwrap_or_default();

    Some(VEvent {
        uid: text("UID"),
        title: {
            let t = text("SUMMARY");
            if t.is_empty() {
                "(no title)".to_string()
            } else {
                t
            }
        },
        description,
        location,
        conference,
        organizer,
        attendee_count: props.iter().filter(|p| p.name == "ATTENDEE").count(),
        status: text("STATUS").to_uppercase(),
        start,
        duration,
        rrule,
        exdates,
        recurrence_id,
    })
}

// ════════════════════════════════════════════════════════════════════════════
// Expansion
// ════════════════════════════════════════════════════════════════════════════

/// Turn parsed VEVENTs into concrete instances inside `[window_start, window_end]`.
///
/// Recurring series are expanded by scanning candidate days — chronological order, which is what
/// COUNT needs. `RECURRENCE-ID` VEVENTs replace the generated instance at the same instant, and
/// EXDATE instants are dropped. Without this, a moved or cancelled standup would keep showing at
/// its original time forever.
fn expand_events(
    events: Vec<VEvent>,
    calendar_label: &str,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
    default_tz: Option<Tz>,
) -> Vec<CalendarEvent> {
    // Split overrides out of the master list.
    let mut overrides: HashMap<(String, i64), VEvent> = HashMap::new();
    let mut masters: Vec<VEvent> = Vec::new();
    for ev in events {
        match ev.recurrence_id {
            Some(rid) => {
                overrides.insert((ev.uid.clone(), rid.timestamp_millis()), ev);
            }
            None => masters.push(ev),
        }
    }

    let mut out: Vec<CalendarEvent> = Vec::new();
    let mut emitted_overrides: HashSet<(String, i64)> = HashSet::new();

    for ev in &masters {
        let ex: HashSet<i64> = ev.exdates.iter().map(|d| d.timestamp_millis()).collect();
        let approximate = ev
            .rrule
            .as_ref()
            .map(|r| !r.unsupported.is_empty())
            .unwrap_or(false);

        let Some(rule) = ev.rrule.clone() else {
            // Single event.
            let start = resolve_instant(ev.start.zone, ev.start.naive, default_tz);
            let end = start + ev.duration;
            if end >= window_start && start <= window_end {
                out.push(to_calendar_event(ev, calendar_label, start, end, false, approximate));
            }
            continue;
        };

        let start_date = ev.start.naive.date();
        let start_time = ev.start.naive.time();

        // COUNT is relative to DTSTART, so a counted series must be walked from the beginning.
        // Otherwise start near the window to keep the scan short.
        let scan_from = if rule.count.is_some() {
            start_date
        } else {
            let win_date = window_start.with_timezone(&Utc).date_naive() - Duration::days(2);
            if win_date > start_date {
                win_date
            } else {
                start_date
            }
        };
        let scan_to = window_end.with_timezone(&Utc).date_naive() + Duration::days(2);

        let mut seen_count: u32 = 0;
        let mut emitted = 0usize;
        let mut date = scan_from;
        let mut guard = 0usize;

        // When scanning from the window (not DTSTART) COUNT is unused, so the counter only has
        // to be accurate in the branch where scan_from == start_date.
        while date <= scan_to && guard < MAX_SCAN_DAYS && emitted < MAX_OCCURRENCES {
            guard += 1;
            if rule_matches(&rule, start_date, date) {
                seen_count += 1;
                if let Some(c) = rule.count {
                    if seen_count > c {
                        break;
                    }
                }
                let occ_start = resolve_instant(ev.start.zone, date.and_time(start_time), default_tz);
                if let Some(until) = rule.until {
                    if occ_start > until {
                        break;
                    }
                }
                let occ_end = occ_start + ev.duration;
                let key = (ev.uid.clone(), occ_start.timestamp_millis());

                if !ex.contains(&occ_start.timestamp_millis())
                    && occ_end >= window_start
                    && occ_start <= window_end
                {
                    match overrides.get(&key) {
                        Some(ov) => {
                            let ov_start = resolve_instant(ov.start.zone, ov.start.naive, default_tz);
                            let ov_end = ov_start + ov.duration;
                            if ov.status != "CANCELLED" {
                                out.push(to_calendar_event(
                                    ov,
                                    calendar_label,
                                    ov_start,
                                    ov_end,
                                    true,
                                    approximate,
                                ));
                            }
                            emitted_overrides.insert(key);
                        }
                        None => out.push(to_calendar_event(
                            ev,
                            calendar_label,
                            occ_start,
                            occ_end,
                            true,
                            approximate,
                        )),
                    }
                    emitted += 1;
                }
            }
            match date.succ_opt() {
                Some(d) => date = d,
                None => break,
            }
        }
    }

    // An override can be moved outside its original slot (or its master may be missing from the
    // feed window). Emit any that the scan did not already place.
    for (key, ov) in &overrides {
        if emitted_overrides.contains(key) || ov.status == "CANCELLED" {
            continue;
        }
        let start = resolve_instant(ov.start.zone, ov.start.naive, default_tz);
        let end = start + ov.duration;
        if end >= window_start && start <= window_end {
            out.push(to_calendar_event(ov, calendar_label, start, end, true, false));
        }
    }

    out
}

fn to_calendar_event(
    ev: &VEvent,
    calendar_label: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    recurring: bool,
    approximate: bool,
) -> CalendarEvent {
    let (meeting_url, meeting_kind) =
        extract_conference(&ev.description, &ev.location, &ev.conference);
    CalendarEvent {
        uid: ev.uid.clone(),
        calendar: calendar_label.to_string(),
        title: ev.title.clone(),
        start: start.timestamp_millis(),
        end: end.timestamp_millis(),
        all_day: ev.start.all_day,
        location: ev.location.clone(),
        description: truncate_chars(&ev.description, 1500),
        meeting_url,
        meeting_kind,
        organizer: ev.organizer.clone(),
        attendee_count: ev.attendee_count,
        recurring,
        approximate,
        status: ev.status.clone(),
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

// ════════════════════════════════════════════════════════════════════════════
// Fetch + cache
// ════════════════════════════════════════════════════════════════════════════

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("calendar-cache");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create calendar cache: {}", e))?;
    Ok(dir)
}

fn cache_path(app: &AppHandle, url: &str) -> Result<PathBuf, String> {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hash = hex::encode(hasher.finalize());
    Ok(cache_dir(app)?.join(format!("{}.ics", &hash[..16])))
}

async fn fetch_ics(url: &str) -> Result<String, String> {
    // Google rejects webcal:// at the HTTP layer.
    let url = url
        .trim()
        .replacen("webcal://", "https://", 1)
        .to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Feed URL must start with https:// (or webcal://)".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "AIVoiceHub/0.5 (calendar subscription)")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read body: {}", e))?;

    if !body.contains("BEGIN:VCALENDAR") {
        return Err("Response is not an iCalendar feed (no BEGIN:VCALENDAR)".to_string());
    }
    Ok(body)
}

fn file_mtime_ms(path: &PathBuf) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ════════════════════════════════════════════════════════════════════════════
// Commands
// ════════════════════════════════════════════════════════════════════════════

/// Fetch every enabled feed (or reuse a fresh cache) and return meetings in the window.
#[tauri::command]
pub async fn get_calendar_events(
    app: AppHandle,
    state: State<'_, SettingsState>,
    args: GetEventsArgs,
) -> Result<CalendarResult, String> {
    // Copy what we need and drop the guard — it must not be held across an await.
    let (feeds, days_ahead, refresh_minutes, only_with_meet, tz_name) = {
        let s = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (
            s.calendar_feeds.clone(),
            s.calendar_days_ahead,
            s.calendar_refresh_minutes,
            s.calendar_only_with_meet,
            s.calendar_timezone.clone(),
        )
    };

    let default_tz: Option<Tz> = if tz_name.trim().is_empty() {
        None
    } else {
        tz_name.trim().parse::<Tz>().ok()
    };

    let days = args.days_ahead.unwrap_or(days_ahead).clamp(1, 60) as i64;
    let now = Utc::now();
    let window_start = now - Duration::hours(LOOKBACK_HOURS);
    let window_end = now + Duration::days(days);

    let force = args.refresh.unwrap_or(false);
    let mut warnings: Vec<String> = Vec::new();
    let mut all_events: Vec<CalendarEvent> = Vec::new();
    let mut statuses: Vec<FeedStatus> = Vec::new();

    let enabled: Vec<CalendarFeed> = feeds.into_iter().filter(|f| f.enabled).collect();

    for feed in &enabled {
        let path = cache_path(&app, &feed.url)?;
        let cache_age_ms = if path.exists() {
            now.timestamp_millis() - file_mtime_ms(&path)
        } else {
            i64::MAX
        };
        let ttl_ms = (refresh_minutes as i64).max(0) * 60_000;
        let cache_is_fresh = !force && ttl_ms > 0 && cache_age_ms < ttl_ms;

        let (body, from_cache, fetched_at, error) = if cache_is_fresh {
            match fs::read_to_string(&path) {
                Ok(b) => (Some(b), true, file_mtime_ms(&path), String::new()),
                Err(_) => match fetch_ics(&feed.url).await {
                    Ok(b) => {
                        let _ = fs::write(&path, &b);
                        (Some(b), false, now.timestamp_millis(), String::new())
                    }
                    Err(e) => (None, false, 0, e),
                },
            }
        } else {
            match fetch_ics(&feed.url).await {
                Ok(b) => {
                    let _ = fs::write(&path, &b);
                    (Some(b), false, now.timestamp_millis(), String::new())
                }
                Err(e) => {
                    // Network failed — a stale agenda beats an empty one.
                    match fs::read_to_string(&path) {
                        Ok(b) => (Some(b), true, file_mtime_ms(&path), e),
                        Err(_) => (None, false, 0, e),
                    }
                }
            }
        };

        let Some(body) = body else {
            statuses.push(FeedStatus {
                label: feed_label(feed),
                url: feed.url.clone(),
                ok: false,
                error,
                fetched_at: 0,
                from_cache: false,
                event_count: 0,
            });
            continue;
        };

        let (vevents, cal_name) = parse_ics(&body, &mut warnings);
        let label = if !feed.label.trim().is_empty() {
            feed.label.trim().to_string()
        } else if !cal_name.is_empty() {
            cal_name
        } else {
            feed_label(feed)
        };

        let expanded = expand_events(vevents, &label, window_start, window_end, default_tz);
        let count = expanded.len();
        all_events.extend(expanded);

        statuses.push(FeedStatus {
            label,
            url: feed.url.clone(),
            ok: true,
            error,
            fetched_at,
            from_cache,
            event_count: count,
        });
    }

    all_events.retain(|e| e.status != "CANCELLED");
    if only_with_meet {
        all_events.retain(|e| !e.meeting_url.is_empty());
    }
    all_events.sort_by(|a, b| a.start.cmp(&b.start).then(a.title.cmp(&b.title)));

    // Same meeting present on two subscribed calendars → keep one.
    let mut seen: HashSet<(String, i64)> = HashSet::new();
    all_events.retain(|e| seen.insert((e.uid.clone(), e.start)));

    Ok(CalendarResult {
        events: all_events,
        feeds: statuses,
        window_start: window_start.timestamp_millis(),
        window_end: window_end.timestamp_millis(),
        warnings,
    })
}

fn feed_label(feed: &CalendarFeed) -> String {
    if !feed.label.trim().is_empty() {
        return feed.label.trim().to_string();
    }
    // Fall back to the calendar id embedded in a Google ICS URL.
    feed.url
        .split("/calendar/ical/")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .map(|id| {
            let decoded = id.replace("%40", "@");
            decoded
        })
        .unwrap_or_else(|| "Calendar".to_string())
}

/// Validate a feed URL from Settings without storing it.
#[tauri::command]
pub async fn test_calendar_feed(url: String) -> Result<TestFeedResult, String> {
    match fetch_ics(&url).await {
        Ok(body) => {
            let mut warnings = Vec::new();
            let (events, cal_name) = parse_ics(&body, &mut warnings);
            let now = Utc::now();
            let expanded = expand_events(
                events.clone(),
                "test",
                now - Duration::hours(LOOKBACK_HOURS),
                now + Duration::days(7),
                None,
            );
            Ok(TestFeedResult {
                ok: true,
                calendar_name: cal_name,
                event_count: events.len(),
                upcoming_count: expanded.len(),
                error: String::new(),
            })
        }
        Err(e) => Ok(TestFeedResult {
            ok: false,
            calendar_name: String::new(),
            event_count: 0,
            upcoming_count: 0,
            error: e,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfolds_continuation_lines() {
        let raw = "SUMMARY:Hello\r\n  world\r\nUID:1\r\n";
        let lines = unfold(raw);
        assert_eq!(lines[0], "SUMMARY:Hello world");
        assert_eq!(lines[1], "UID:1");
    }

    #[test]
    fn splits_value_after_quoted_param_containing_colon() {
        let cl = parse_content_line("ATTENDEE;CN=\"Doe, J:r\":mailto:x@y.z").unwrap();
        assert_eq!(cl.name, "ATTENDEE");
        assert_eq!(cl.param("CN"), Some("Doe, J:r"));
        assert_eq!(cl.value, "mailto:x@y.z");
    }

    #[test]
    fn parses_three_dtstart_forms() {
        let mut w = Vec::new();
        let utc = parse_moment(
            &parse_content_line("DTSTART:20260806T010000Z").unwrap(),
            &mut w,
        )
        .unwrap();
        assert!(!utc.all_day);
        assert_eq!(
            resolve_instant(utc.zone, utc.naive, None).to_rfc3339(),
            "2026-08-06T01:00:00+00:00"
        );

        let tokyo = parse_moment(
            &parse_content_line("DTSTART;TZID=Asia/Tokyo:20260806T100000").unwrap(),
            &mut w,
        )
        .unwrap();
        // 10:00 JST == 01:00 UTC
        assert_eq!(
            resolve_instant(tokyo.zone, tokyo.naive, None).to_rfc3339(),
            "2026-08-06T01:00:00+00:00"
        );

        let all_day = parse_moment(
            &parse_content_line("DTSTART;VALUE=DATE:20260806").unwrap(),
            &mut w,
        )
        .unwrap();
        assert!(all_day.all_day);
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1D"), Some(Duration::days(1)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
    }

    #[test]
    fn weekly_byday_matches_only_listed_days() {
        let mut w = Vec::new();
        let rule = parse_rrule("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1", &mut w).unwrap();
        let start = NaiveDate::from_ymd_opt(2026, 8, 3).unwrap(); // Monday
        assert!(rule_matches(&rule, start, NaiveDate::from_ymd_opt(2026, 8, 5).unwrap())); // Wed
        assert!(!rule_matches(&rule, start, NaiveDate::from_ymd_opt(2026, 8, 6).unwrap())); // Thu
        assert!(rule_matches(&rule, start, NaiveDate::from_ymd_opt(2026, 8, 10).unwrap())); // next Mon
    }

    #[test]
    fn biweekly_skips_the_off_week() {
        let mut w = Vec::new();
        let rule = parse_rrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH", &mut w).unwrap();
        let start = NaiveDate::from_ymd_opt(2026, 8, 6).unwrap(); // Thursday
        assert!(rule_matches(&rule, start, NaiveDate::from_ymd_opt(2026, 8, 20).unwrap()));
        assert!(!rule_matches(&rule, start, NaiveDate::from_ymd_opt(2026, 8, 13).unwrap()));
    }

    #[test]
    fn monthly_nth_weekday_and_last_weekday() {
        let mut w = Vec::new();
        let second_tue = parse_rrule("FREQ=MONTHLY;BYDAY=2TU", &mut w).unwrap();
        let start = NaiveDate::from_ymd_opt(2026, 8, 11).unwrap(); // 2nd Tue of Aug 2026
        assert!(rule_matches(&second_tue, start, NaiveDate::from_ymd_opt(2026, 9, 8).unwrap()));
        assert!(!rule_matches(&second_tue, start, NaiveDate::from_ymd_opt(2026, 9, 15).unwrap()));

        let last_fri = parse_rrule("FREQ=MONTHLY;BYDAY=-1FR", &mut w).unwrap();
        let s2 = NaiveDate::from_ymd_opt(2026, 8, 28).unwrap();
        assert!(rule_matches(&last_fri, s2, NaiveDate::from_ymd_opt(2026, 9, 25).unwrap()));
        assert!(!rule_matches(&last_fri, s2, NaiveDate::from_ymd_opt(2026, 9, 18).unwrap()));
    }

    #[test]
    fn finds_meet_link_in_description_when_property_absent() {
        let desc = "Join here: https://meet.google.com/abc-defg-hij or dial in";
        let (url, kind) = extract_conference(desc, "", "");
        assert_eq!(url, "https://meet.google.com/abc-defg-hij");
        assert_eq!(kind, "meet");
    }

    #[test]
    fn prefers_x_google_conference_over_description() {
        let (url, _) = extract_conference(
            "old link https://meet.google.com/zzz-zzzz-zzz",
            "Room 1",
            "https://meet.google.com/aaa-bbbb-ccc",
        );
        assert_eq!(url, "https://meet.google.com/aaa-bbbb-ccc");
    }

    #[test]
    fn exdate_removes_one_instance_and_recurrence_id_moves_another() {
        let ics = "BEGIN:VCALENDAR\r\n\
X-WR-CALNAME:Work\r\n\
BEGIN:VEVENT\r\n\
UID:standup\r\n\
SUMMARY:Standup\r\n\
DTSTART:20260803T000000Z\r\n\
DTEND:20260803T001500Z\r\n\
RRULE:FREQ=DAILY;COUNT=5\r\n\
EXDATE:20260805T000000Z\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:standup\r\n\
SUMMARY:Standup (moved)\r\n\
RECURRENCE-ID:20260804T000000Z\r\n\
DTSTART:20260804T060000Z\r\n\
DTEND:20260804T061500Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";
        let mut w = Vec::new();
        let (events, name) = parse_ics(ics, &mut w);
        assert_eq!(name, "Work");
        let start = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 8, 10, 0, 0, 0).unwrap();
        let out = expand_events(events, "Work", start, end, None);

        // COUNT=5 from Aug 3 → Aug 3,4,5,6,7 ; Aug 5 excluded → 4 instances
        assert_eq!(out.len(), 4, "got {:?}", out.iter().map(|e| e.start).collect::<Vec<_>>());
        assert!(!out.iter().any(|e| e.start
            == Utc.with_ymd_and_hms(2026, 8, 5, 0, 0, 0).unwrap().timestamp_millis()));
        // The Aug 4 instance was moved to 06:00 by the override.
        let moved = out
            .iter()
            .find(|e| e.title == "Standup (moved)")
            .expect("override instance missing");
        assert_eq!(
            moved.start,
            Utc.with_ymd_and_hms(2026, 8, 4, 6, 0, 0).unwrap().timestamp_millis()
        );
    }

    /// End-to-end on a document shaped like a real Google Calendar export: VTIMEZONE block,
    /// folded DESCRIPTION, `X-GOOGLE-CONFERENCE`, and a TZID-anchored weekly recurrence.
    #[test]
    fn parses_a_google_shaped_feed() {
        let ics = "BEGIN:VCALENDAR\r\n\
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r\n\
VERSION:2.0\r\n\
CALSCALE:GREGORIAN\r\n\
X-WR-CALNAME:t.nguyen@share-wis.com\r\n\
X-WR-TIMEZONE:Asia/Tokyo\r\n\
BEGIN:VTIMEZONE\r\n\
TZID:Asia/Tokyo\r\n\
BEGIN:STANDARD\r\n\
TZOFFSETFROM:+0900\r\n\
TZOFFSETTO:+0900\r\n\
TZNAME:JST\r\n\
DTSTART:19700101T000000\r\n\
END:STANDARD\r\n\
END:VTIMEZONE\r\n\
BEGIN:VEVENT\r\n\
DTSTART;TZID=Asia/Tokyo:20260803T100000\r\n\
DTEND;TZID=Asia/Tokyo:20260803T103000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO,TH\r\n\
DTSTAMP:20260801T000000Z\r\n\
UID:standup123@google.com\r\n\
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij\r\n\
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Tan\r\n \
 Nguyen;X-NUM-GUESTS=0:mailto:t.nguyen@share-wis.com\r\n\
ATTENDEE;CN=Phat;X-NUM-GUESTS=0:mailto:phat@share-wis.com\r\n\
ORGANIZER;CN=Tan Nguyen:mailto:t.nguyen@share-wis.com\r\n\
DESCRIPTION:Daily sync.\\n\\nJoin with Google Meet: https://meet.google.com/a\r\n \
 bc-defg-hij\\nOr dial in.\r\n\
LOCATION:\r\n\
SEQUENCE:0\r\n\
STATUS:CONFIRMED\r\n\
SUMMARY:Platform standup\r\n\
TRANSP:OPAQUE\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
DTSTART;VALUE=DATE:20260807\r\n\
DTEND;VALUE=DATE:20260808\r\n\
UID:holiday456@google.com\r\n\
SUMMARY:Company holiday\r\n\
STATUS:CONFIRMED\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

        let mut warnings = Vec::new();
        let (events, cal_name) = parse_ics(ics, &mut warnings);
        assert_eq!(cal_name, "t.nguyen@share-wis.com");
        assert_eq!(events.len(), 2, "VTIMEZONE must not be read as an event");
        assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);

        let standup = &events[0];
        assert_eq!(standup.title, "Platform standup");
        assert_eq!(standup.attendee_count, 2);
        assert_eq!(standup.organizer, "Tan Nguyen");
        assert_eq!(standup.conference, "https://meet.google.com/abc-defg-hij");
        assert_eq!(standup.duration, Duration::minutes(30));

        // Mon 3 Aug – Sun 9 Aug 2026 covers Mon 3, Thu 6 and the all-day holiday on Fri 7.
        let out = expand_events(
            events,
            "Work",
            Utc.with_ymd_and_hms(2026, 8, 3, 0, 0, 0).unwrap(),
            Utc.with_ymd_and_hms(2026, 8, 9, 0, 0, 0).unwrap(),
            None,
        );

        let standups: Vec<&CalendarEvent> =
            out.iter().filter(|e| e.title == "Platform standup").collect();
        assert_eq!(standups.len(), 2, "expected Mon + Thu");
        // 10:00 JST is 01:00 UTC — a UTC-vs-TZID mix-up would land this 9 hours off.
        assert_eq!(
            standups[0].start,
            Utc.with_ymd_and_hms(2026, 8, 3, 1, 0, 0).unwrap().timestamp_millis()
        );
        assert_eq!(
            standups[1].start,
            Utc.with_ymd_and_hms(2026, 8, 6, 1, 0, 0).unwrap().timestamp_millis()
        );
        assert!(standups.iter().all(|e| e.meeting_kind == "meet"));
        assert!(standups.iter().all(|e| e.recurring && !e.approximate));

        let holiday = out
            .iter()
            .find(|e| e.title == "Company holiday")
            .expect("all-day event missing");
        assert!(holiday.all_day);
        assert!(!holiday.recurring);
    }

    #[test]
    fn cancelled_events_are_parsed_with_status() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Gone\r\n\
DTSTART:20260806T000000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let mut w = Vec::new();
        let (events, _) = parse_ics(ics, &mut w);
        assert_eq!(events[0].status, "CANCELLED");
    }

    #[test]
    fn valarm_body_does_not_leak_into_the_event() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Real\r\n\
DTSTART:20260806T000000Z\r\nBEGIN:VALARM\r\nSUMMARY:Reminder\r\nEND:VALARM\r\n\
END:VEVENT\r\nEND:VCALENDAR\r\n";
        let mut w = Vec::new();
        let (events, _) = parse_ics(ics, &mut w);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Real");
    }
}
