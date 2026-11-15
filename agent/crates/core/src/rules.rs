//! Automation rules (ADR 0011): "when this holds for a while, do that to the panel". Nothing here knows the PC, the clock or the network: the
//! caller reads the world into `Facts` and a time in milliseconds, and `Engine::step` says what to do. A rule only ever touches the panel
//! (switch the page, show a notice, keep a value), the same as a webhook; none of them acts on the PC.
//!
//! A rule in `config.json`:
//! ```json
//! { "id": "cpu-alta", "when": { "type": "cpu-above", "percent": 90 }, "for": 15, "cooldown": 5,
//!   "do": { "type": "notify", "title": "PC", "text": "CPU alta" } }
//! ```
use std::collections::HashMap;

use serde_json::{json, Value};

/// A condition has to stay off this long before a rule ends, so a flickering one does not flap.
pub const RELEASE_SEC: u64 = 4;
/// CPU spikes are normal: the CPU rule waits this long unless the rule says its own `for`.
pub const CPU_SUSTAIN_SEC: u64 = 15;
pub const MAX_RULES: usize = 50;
/// The longest pause (a day).
pub const MAX_PAUSE_MIN: u64 = 24 * 60;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("rules: {0}")]
pub struct RuleError(pub String);

#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    /// the CPU usage is at or above this many percent
    CpuAbove(f64),
    /// some player is playing
    MediaPlaying,
    /// some window's title contains this text (lower case)
    WindowTitleContains(String),
    /// a notification from this app (lower case) arrived since the last look
    NotificationFrom(String),
    /// the local time is in `[from, to)` in minutes since midnight; `from > to` crosses midnight
    TimeWindow { from: u16, to: u16 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Goto(String),
    Notify {
        title: String,
        text: String,
    },
    Push {
        key: String,
        value: Value,
        ttl: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub id: String,
    pub when: Condition,
    /// seconds the condition has to hold before the rule fires
    pub for_sec: u64,
    pub cooldown_min: u64,
    /// undo the effect (back to the page it was on, the value removed) when the condition ends
    pub while_active: bool,
    pub action: Action,
}

fn bad<T>(index: usize, message: &str) -> Result<T, RuleError> {
    Err(RuleError(format!("rule {}: {message}", index + 1)))
}

fn text<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// "22:30" as minutes since midnight.
fn minutes(clock: &str) -> Option<u16> {
    let (hours, mins) = clock.split_once(':')?;
    let (hours, mins) = (hours.parse::<u16>().ok()?, mins.parse::<u16>().ok()?);
    (hours < 24 && mins < 60 && clock.len() == 5).then_some(hours * 60 + mins)
}

fn valid_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn number(object: &Value, key: &str, max: u64) -> Result<Option<u64>, ()> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_u64().filter(|v| *v <= max).map(Some).ok_or(()),
        Some(_) => Err(()),
    }
}

fn condition(index: usize, when: &Value) -> Result<Condition, RuleError> {
    match text(when, "type") {
        Some("cpu-above") => match when.get("percent").and_then(Value::as_f64) {
            Some(p) if (1.0..=100.0).contains(&p) => Ok(Condition::CpuAbove(p)),
            _ => bad(index, "cpu-above needs a percent from 1 to 100"),
        },
        Some("media-playing") => Ok(Condition::MediaPlaying),
        Some("window-title-contains") => match text(when, "text").map(str::trim) {
            Some(t) if !t.is_empty() && t.len() <= 80 => {
                Ok(Condition::WindowTitleContains(t.to_lowercase()))
            }
            _ => bad(index, "window-title-contains needs a text of up to 80 characters"),
        },
        Some("notification-from") => match text(when, "app").map(str::trim) {
            Some(t) if !t.is_empty() && t.len() <= 80 => {
                Ok(Condition::NotificationFrom(t.to_lowercase()))
            }
            _ => bad(index, "notification-from needs an app name"),
        },
        Some("time-window") => {
            let from = text(when, "from").and_then(minutes);
            let to = text(when, "to").and_then(minutes);
            match (from, to) {
                (Some(from), Some(to)) if from != to => Ok(Condition::TimeWindow { from, to }),
                _ => bad(index, "time-window needs different from and to times, as HH:MM"),
            }
        }
        _ => bad(
            index,
            "when.type is cpu-above, media-playing, window-title-contains, notification-from or time-window",
        ),
    }
}

fn action(index: usize, run: &Value) -> Result<Action, RuleError> {
    match text(run, "type") {
        Some("goto") => match text(run, "page") {
            Some(page) if crate::push::valid_page(page) => Ok(Action::Goto(page.to_owned())),
            _ => bad(index, "goto needs a page (a-z, 0-9 and '-')"),
        },
        Some("notify") => {
            let body = text(run, "text").map(str::trim).unwrap_or_default();
            let title = text(run, "title").map(str::trim).unwrap_or_default();
            if body.is_empty() || body.chars().count() > 500 || title.chars().count() > 120 {
                return bad(
                    index,
                    "notify needs a text of up to 500 characters (the title up to 120)",
                );
            }
            Ok(Action::Notify {
                title: title.to_owned(),
                text: body.to_owned(),
            })
        }
        Some("push") => {
            let key = text(run, "key").unwrap_or_default();
            let Some(value) = run.get("value").filter(|v| !v.is_null()) else {
                return bad(index, "push needs a value");
            };
            let Ok(ttl) = number(run, "ttl", crate::push::MAX_TTL_SEC) else {
                return bad(index, "push ttl is a number of seconds up to 30 days");
            };
            if !crate::push::valid_key(key) {
                return bad(
                    index,
                    "push needs a key of 1-64 characters (letters, digits, '.', '_', '-')",
                );
            }
            Ok(Action::Push {
                key: key.to_owned(),
                value: value.clone(),
                ttl,
            })
        }
        _ => bad(index, "do.type is goto, notify or push"),
    }
}

/// The enabled rules of the `rules` key of `config.json`, checked. One wrong rule refuses the whole list (so a typo is seen, not half applied).
pub fn parse(rules: &Value) -> Result<Vec<Rule>, RuleError> {
    let Some(list) = rules.as_array() else {
        return Err(RuleError("rules must be a list".into()));
    };
    if list.len() > MAX_RULES {
        return Err(RuleError(format!("at most {MAX_RULES} rules")));
    }
    let mut out: Vec<Rule> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (index, item) in list.iter().enumerate() {
        let id = text(item, "id").unwrap_or_default();
        if !valid_id(id) {
            return bad(index, "id is 1-40 characters: a-z, 0-9 and '-'");
        }
        if seen.contains(&id) {
            return bad(index, &format!("the id {id} is used twice"));
        }
        seen.push(id);
        if item.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let Some(when) = item.get("when").filter(|w| w.is_object()) else {
            return bad(index, "when is missing");
        };
        let Some(run) = item.get("do").filter(|d| d.is_object()) else {
            return bad(index, "do is missing");
        };
        let (Ok(for_sec), Ok(cooldown)) =
            (number(item, "for", 3600), number(item, "cooldown", 1440))
        else {
            return bad(
                index,
                "for is up to 3600 seconds and cooldown up to 1440 minutes",
            );
        };
        let when = condition(index, when)?;
        let for_sec = for_sec.unwrap_or(if matches!(when, Condition::CpuAbove(_)) {
            CPU_SUSTAIN_SEC
        } else {
            0
        });
        out.push(Rule {
            id: id.to_owned(),
            when,
            for_sec,
            cooldown_min: cooldown.unwrap_or(0),
            while_active: item.get("whileActive") == Some(&Value::Bool(true)),
            action: action(index, run)?,
        });
    }
    Ok(out)
}

/// What the world looks like at this step; the caller fills in only what some rule asks for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub cpu: Option<f64>,
    pub media_playing: bool,
    /// the titles of the visible windows, lower case
    pub window_titles: Vec<String>,
    /// the apps (lower case) that had a new notification since the last step
    pub notified_apps: Vec<String>,
    /// local time, minutes since midnight
    pub minute: u16,
}

impl Facts {
    fn holds(&self, when: &Condition) -> bool {
        match when {
            Condition::CpuAbove(percent) => self.cpu.is_some_and(|c| c >= *percent),
            Condition::MediaPlaying => self.media_playing,
            Condition::WindowTitleContains(text) => {
                self.window_titles.iter().any(|title| title.contains(text))
            }
            Condition::NotificationFrom(app) => {
                self.notified_apps.iter().any(|name| name.contains(app))
            }
            Condition::TimeWindow { from, to } if from < to => (*from..*to).contains(&self.minute),
            Condition::TimeWindow { from, to } => self.minute >= *from || self.minute < *to,
        }
    }
}

/// What a step asks the caller to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Run {
        rule: String,
        action: Action,
    },
    /// the rule ended (or was edited or paused) and wants its effect taken back
    Undo {
        rule: String,
        action: Action,
    },
}

impl Effect {
    /// The panel event or value change that carries the effect out, as JSON for the caller to apply: `("goto", {page, rule})`, `("back", {rule})`,
    /// `("notify", {title, text})`, or a push (`("push", {key, value, ttl})`) and its removal (`("unpush", {key})`).
    pub fn describe(&self) -> Option<(&'static str, Value)> {
        match self {
            Effect::Run { rule, action } => Some(match action {
                Action::Goto(page) => ("goto", json!({ "page": page, "rule": rule })),
                Action::Notify { title, text } => {
                    ("notify", json!({ "title": title, "text": text }))
                }
                Action::Push { key, value, ttl } => {
                    ("push", json!({ "key": key, "value": value, "ttl": ttl }))
                }
            }),
            Effect::Undo { rule, action } => match action {
                Action::Goto(_) => Some(("back", json!({ "rule": rule }))),
                Action::Push { key, .. } => Some(("unpush", json!({ "key": key }))),
                Action::Notify { .. } => None,
            },
        }
    }
}

struct State {
    rule: Rule,
    active: bool,
    true_since: Option<u64>,
    false_since: Option<u64>,
}

#[derive(Default)]
pub struct Engine {
    /// by the rule's whole definition, so editing a rule ends the old version and starts the new one
    states: HashMap<String, State>,
    /// when each rule (by id) last fired, for the cooldown; survives edits of the rule
    fired: HashMap<String, u64>,
    active: Vec<String>,
    paused_until: u64,
}

impl Engine {
    /// The ids of the rules whose condition holds now.
    pub fn active(&self) -> &[String] {
        &self.active
    }

    /// Pauses every rule for `minutes` (0 resumes); a rule that holds ends at the next step and may fire again after the pause.
    pub fn pause(&mut self, minutes: u64, now: u64) {
        self.paused_until = if minutes == 0 {
            0
        } else {
            now + minutes.min(MAX_PAUSE_MIN) * 60_000
        };
    }

    /// Unix-style `now` of the end of the pause, or `None` when the rules are running.
    pub fn paused_until(&self, now: u64) -> Option<u64> {
        (self.paused_until > now).then_some(self.paused_until)
    }

    pub fn step(&mut self, rules: &[Rule], facts: &Facts, now: u64) -> Vec<Effect> {
        let mut effects = Vec::new();
        let paused = self.paused_until(now).is_some();
        let keys: HashMap<String, &Rule> = rules.iter().map(|r| (format!("{r:?}"), r)).collect();

        let gone: Vec<String> = self
            .states
            .keys()
            .filter(|key| paused || !keys.contains_key(*key))
            .cloned()
            .collect();
        for key in gone {
            if let Some(state) = self.states.remove(&key) {
                if state.active && state.rule.while_active {
                    effects.push(Effect::Undo {
                        rule: state.rule.id.clone(),
                        action: state.rule.action.clone(),
                    });
                }
                // the edit or the pause took the effect back, not the condition: the new version may fire at once
                self.fired.remove(&state.rule.id);
            }
        }
        if paused {
            self.active.clear();
            return effects;
        }

        let mut active = Vec::new();
        for rule in rules {
            let state = self
                .states
                .entry(format!("{rule:?}"))
                .or_insert_with(|| State {
                    rule: rule.clone(),
                    active: false,
                    true_since: None,
                    false_since: None,
                });
            if facts.holds(&rule.when) {
                state.false_since = None;
                state.true_since.get_or_insert(now);
            } else {
                state.true_since = None;
                state.false_since.get_or_insert(now);
            }
            let sustained = state
                .true_since
                .is_some_and(|since| now.saturating_sub(since) >= rule.for_sec * 1000);
            let cooled = self
                .fired
                .get(&rule.id)
                .is_none_or(|last| now.saturating_sub(*last) >= rule.cooldown_min * 60_000);
            if sustained && !state.active && cooled {
                state.active = true;
                self.fired.insert(rule.id.clone(), now);
                effects.push(Effect::Run {
                    rule: rule.id.clone(),
                    action: rule.action.clone(),
                });
            } else if state.true_since.is_none() && state.active {
                let ended = state
                    .false_since
                    .is_some_and(|since| now.saturating_sub(since) >= RELEASE_SEC * 1000)
                    // a time window has no flicker to wait out
                    || matches!(rule.when, Condition::TimeWindow { .. });
                if ended {
                    state.active = false;
                    if rule.while_active {
                        effects.push(Effect::Undo {
                            rule: rule.id.clone(),
                            action: rule.action.clone(),
                        });
                    }
                }
            }
            if state.active {
                active.push(rule.id.clone());
            }
        }
        self.active = active;
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(value: Value) -> Vec<Rule> {
        parse(&value).unwrap()
    }

    fn cpu_rule(extra: Value) -> Value {
        let mut rule = json!({ "id": "cpu", "when": { "type": "cpu-above", "percent": 90 }, "do": { "type": "notify", "text": "alta" } });
        for (k, v) in extra.as_object().unwrap() {
            rule[k] = v.clone();
        }
        rule
    }

    fn hot(cpu: f64) -> Facts {
        Facts {
            cpu: Some(cpu),
            ..Facts::default()
        }
    }

    fn runs(effects: &[Effect]) -> usize {
        effects
            .iter()
            .filter(|e| matches!(e, Effect::Run { .. }))
            .count()
    }

    #[test]
    fn a_rule_is_parsed_with_its_defaults_and_a_cpu_rule_waits_15_seconds_unless_told() {
        let parsed = rules(
            json!([cpu_rule(json!({})), { "id": "m", "when": { "type": "media-playing" }, "do": { "type": "goto", "page": "sound" } }]),
        );
        assert_eq!((parsed[0].for_sec, parsed[1].for_sec), (15, 0));
        assert_eq!(rules(json!([cpu_rule(json!({ "for": 0 }))]))[0].for_sec, 0);
        assert!(!parsed[0].while_active);
        assert_eq!(parsed[1].action, Action::Goto("sound".into()));
    }

    #[test]
    fn a_disabled_rule_is_left_out_and_a_wrong_one_refuses_the_whole_list() {
        assert!(rules(json!([cpu_rule(json!({ "enabled": false }))])).is_empty());
        for wrong in [
            json!({ "id": "Bad Id", "when": { "type": "media-playing" }, "do": { "type": "refresh" } }),
            cpu_rule(json!({ "when": { "type": "cpu-above", "percent": 0 } })),
            cpu_rule(json!({ "when": { "type": "time-window", "from": "22:00", "to": "22:00" } })),
            cpu_rule(json!({ "when": { "type": "time-window", "from": "25:00", "to": "06:00" } })),
            cpu_rule(json!({ "do": { "type": "goto", "page": "Some Page" } })),
            cpu_rule(json!({ "do": { "type": "notify", "text": "" } })),
            cpu_rule(json!({ "do": { "type": "push", "key": "a b", "value": 1 } })),
            cpu_rule(json!({ "for": 99999 })),
            cpu_rule(json!({ "do": { "type": "format-disk" } })),
        ] {
            assert!(parse(&json!([wrong.clone()])).is_err(), "{wrong}");
        }
        let twice = json!([cpu_rule(json!({})), cpu_rule(json!({}))]);
        assert!(parse(&twice).unwrap_err().0.contains("used twice"));
        assert!(parse(&json!("nope")).is_err());
    }

    #[test]
    fn it_fires_only_after_the_condition_held_for_the_time_asked() {
        let rules = rules(json!([cpu_rule(json!({ "for": 15 }))]));
        let mut engine = Engine::default();
        assert!(engine.step(&rules, &hot(95.0), 0).is_empty());
        assert!(engine.step(&rules, &hot(95.0), 14_999).is_empty());
        // a dip resets the count
        assert!(engine.step(&rules, &hot(10.0), 15_000).is_empty());
        assert!(engine.step(&rules, &hot(95.0), 16_000).is_empty());
        let fired = engine.step(&rules, &hot(95.0), 31_000);
        assert_eq!(runs(&fired), 1);
        assert_eq!(engine.active(), ["cpu"]);
        assert!(
            engine.step(&rules, &hot(95.0), 32_000).is_empty(),
            "once, while it holds"
        );
    }

    #[test]
    fn the_cooldown_holds_it_back_and_a_flicker_does_not_end_it() {
        let rules = rules(json!([cpu_rule(json!({ "for": 0, "cooldown": 5 }))]));
        let mut engine = Engine::default();
        assert_eq!(runs(&engine.step(&rules, &hot(95.0), 0)), 1);
        engine.step(&rules, &hot(10.0), 1_000);
        // 3 s without the condition: still active (a flicker), so no new run when it comes back
        assert_eq!(engine.active(), ["cpu"]);
        assert!(engine.step(&rules, &hot(95.0), 4_000).is_empty());
        // 4 s without it ends the rule, but the cooldown keeps it from firing again before 5 minutes
        engine.step(&rules, &hot(10.0), 5_000);
        engine.step(&rules, &hot(10.0), 9_000);
        assert!(engine.active().is_empty());
        assert!(engine.step(&rules, &hot(95.0), 10_000).is_empty());
        assert_eq!(runs(&engine.step(&rules, &hot(95.0), 300_001)), 1);
    }

    #[test]
    fn a_while_active_rule_takes_its_effect_back_when_the_condition_ends() {
        let rules = rules(
            json!([{ "id": "som", "whileActive": true, "when": { "type": "media-playing" }, "do": { "type": "goto", "page": "sound" } }]),
        );
        let (on, off) = (
            Facts {
                media_playing: true,
                ..Facts::default()
            },
            Facts::default(),
        );
        let mut engine = Engine::default();
        let run = engine.step(&rules, &on, 0);
        assert_eq!(run[0].describe().unwrap().0, "goto");
        assert!(engine.step(&rules, &off, 1_000).is_empty());
        let back = engine.step(&rules, &off, 5_000);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].describe(), Some(("back", json!({ "rule": "som" }))));
    }

    #[test]
    fn a_push_is_removed_when_it_ends_and_a_plain_notice_is_not_taken_back() {
        let push = rules(
            json!([{ "id": "p", "whileActive": true, "when": { "type": "media-playing" }, "do": { "type": "push", "key": "tocando", "value": "sim" } }]),
        );
        let notice = rules(
            json!([{ "id": "n", "whileActive": true, "when": { "type": "media-playing" }, "do": { "type": "notify", "text": "x" } }]),
        );
        let (on, off) = (
            Facts {
                media_playing: true,
                ..Facts::default()
            },
            Facts::default(),
        );
        for (rules, undone) in [(push, Some("unpush")), (notice, None)] {
            let mut engine = Engine::default();
            engine.step(&rules, &on, 0);
            engine.step(&rules, &off, 1_000);
            let end = engine.step(&rules, &off, 6_000);
            assert_eq!(end.first().and_then(Effect::describe).map(|d| d.0), undone);
        }
    }

    #[test]
    fn editing_a_rule_ends_the_old_one_and_starts_the_new_one_at_once() {
        let v1 = rules(
            json!([{ "id": "som", "whileActive": true, "when": { "type": "media-playing" }, "do": { "type": "goto", "page": "sound" } }]),
        );
        let v2 = rules(
            json!([{ "id": "som", "whileActive": true, "when": { "type": "media-playing" }, "do": { "type": "goto", "page": "pc" } }]),
        );
        let on = Facts {
            media_playing: true,
            ..Facts::default()
        };
        let mut engine = Engine::default();
        engine.step(&v1, &on, 0);
        let effects = engine.step(&v2, &on, 1_000);
        assert_eq!(effects.len(), 2, "undo the old, run the new");
        assert!(
            matches!(effects[0], Effect::Undo { .. }) && matches!(effects[1], Effect::Run { .. })
        );
    }

    #[test]
    fn a_pause_ends_the_rules_that_hold_and_they_fire_again_after_it() {
        let rules = rules(
            json!([{ "id": "som", "whileActive": true, "when": { "type": "media-playing" }, "do": { "type": "goto", "page": "sound" } }]),
        );
        let on = Facts {
            media_playing: true,
            ..Facts::default()
        };
        let mut engine = Engine::default();
        engine.step(&rules, &on, 0);
        engine.pause(10, 1_000);
        assert_eq!(engine.paused_until(2_000), Some(601_000));
        let during = engine.step(&rules, &on, 2_000);
        assert!(matches!(during[0], Effect::Undo { .. }));
        assert!(engine.active().is_empty());
        assert!(engine.step(&rules, &on, 3_000).is_empty());
        assert_eq!(runs(&engine.step(&rules, &on, 601_000)), 1);
        engine.pause(0, 601_000);
        assert_eq!(engine.paused_until(601_000), None);
    }

    #[test]
    fn a_time_window_can_cross_midnight() {
        let night = Condition::TimeWindow {
            from: 22 * 60,
            to: 6 * 60,
        };
        let day = Condition::TimeWindow {
            from: 9 * 60,
            to: 17 * 60,
        };
        let at = |minute| Facts {
            minute,
            ..Facts::default()
        };
        assert!(at(23 * 60).holds(&night) && at(0).holds(&night) && at(5 * 60 + 59).holds(&night));
        assert!(!at(6 * 60).holds(&night) && !at(12 * 60).holds(&night));
        assert!(at(9 * 60).holds(&day) && !at(17 * 60).holds(&day) && !at(8 * 60).holds(&day));
    }

    #[test]
    fn titles_and_notifications_match_by_the_text_they_contain() {
        let facts = Facts {
            window_titles: vec!["zoom meeting".into()],
            notified_apps: vec!["whatsapp".into()],
            ..Facts::default()
        };
        assert!(facts.holds(&Condition::WindowTitleContains("zoom".into())));
        assert!(!facts.holds(&Condition::WindowTitleContains("teams".into())));
        assert!(facts.holds(&Condition::NotificationFrom("whats".into())));
        assert!(
            !Facts::default().holds(&Condition::CpuAbove(50.0)),
            "no reading is not hot"
        );
    }
}
