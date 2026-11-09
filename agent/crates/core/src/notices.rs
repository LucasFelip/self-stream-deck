//! Which of the Action Center's notifications the deck shows: the ones from the apps the person listed in `notifications.apps`
//! (words matched against the app's name and its id: "whatsapp" matches "5319275A.WhatsAppDesktop_..."). No words: nothing is shown.
//! Parity with `legacy/server/src/notifications.js`.
use serde_json::{json, Value};

/// What the `notifications` topic carries for these words.
pub fn shown(listing: &Value, words: &[String]) -> Value {
    let access = listing["access"].clone();
    if listing["access"] != "allowed" {
        return json!({ "access": access, "notifications": [] });
    }
    let words: Vec<String> = words
        .iter()
        .map(|w| w.to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    let text = |item: &Value, key: &str| item[key].as_str().unwrap_or_default().to_lowercase();
    let wanted: Vec<Value> = listing["notifications"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|item| words.iter().any(|word| text(item, "app").contains(word) || text(item, "aumid").contains(word)))
                .map(|item| json!({ "id": item["id"], "app": item["app"].as_str().unwrap_or_default(), "title": item["title"], "body": item["body"], "time": item["time"] }))
                .collect()
        })
        .unwrap_or_default();
    json!({ "access": access, "notifications": wanted })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing() -> Value {
        json!({ "access": "allowed", "notifications": [
            { "id": 1, "aumid": "5319275A.WhatsAppDesktop_x!App", "app": "WhatsApp", "title": "Maria", "body": "Oi", "time": 5 },
            { "id": 2, "aumid": "Brave.X", "app": null, "title": "Site", "body": "", "time": 6 } ] })
    }

    #[test]
    fn words_match_the_name_or_the_id() {
        let words = |list: &[&str]| list.iter().map(|w| (*w).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            shown(&listing(), &words(&["whatsapp"]))["notifications"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            shown(&listing(), &words(&["BRAVE"]))["notifications"][0]["app"],
            "",
            "an app without a name shows an empty one"
        );
        assert_eq!(shown(&listing(), &words(&[]))["notifications"], json!([]));
        assert_eq!(
            shown(&listing(), &words(&["", " "]))["notifications"],
            json!([])
        );
        assert_eq!(
            shown(
                &json!({ "access": "denied", "notifications": [] }),
                &words(&["x"])
            ),
            json!({ "access": "denied", "notifications": [] })
        );
    }

    #[test]
    fn the_item_keeps_only_what_the_phone_shows() {
        let item = &shown(&listing(), &["whatsapp".to_owned()])["notifications"][0];
        assert_eq!(
            item,
            &json!({ "id": 1, "app": "WhatsApp", "title": "Maria", "body": "Oi", "time": 5 })
        );
    }
}
