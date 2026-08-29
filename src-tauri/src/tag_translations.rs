use std::{collections::BTreeMap, sync::OnceLock};

use crate::db::AppState;

const ANDROID_TAG_OVERRIDES: &str = include_str!("../resources/tag_overrides.json");
static BUILT_IN_TRANSLATIONS: OnceLock<Result<BTreeMap<String, String>, String>> = OnceLock::new();

fn built_in_translations() -> Result<&'static BTreeMap<String, String>, String> {
    BUILT_IN_TRANSLATIONS
        .get_or_init(|| {
            let translations: BTreeMap<String, String> =
                serde_json::from_str(ANDROID_TAG_OVERRIDES)
                    .map_err(|error| format!("Android版タグ翻訳を読み込めませんでした: {error}"))?;
            Ok(translations
                .into_iter()
                .map(|(name, translated)| (name.trim().to_ascii_lowercase(), translated))
                .filter(|(name, translated)| !name.is_empty() && !translated.trim().is_empty())
                .collect())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Returns the Android Gallery translation dictionary, with Japanese
/// user/database overrides layered on top.
pub fn list_tag_translations(state: &AppState) -> Result<BTreeMap<String, String>, String> {
    let mut translations = built_in_translations()?.clone();
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT t.name, tt.display_name
             FROM tag_translations tt
             JOIN tags t ON t.id = tt.tag_id
             WHERE lower(tt.locale) IN ('ja', 'ja-jp')
             ORDER BY CASE lower(tt.locale) WHEN 'ja-jp' THEN 1 ELSE 0 END",
        )
        .map_err(|error| format!("タグ翻訳の上書きを準備できませんでした: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("タグ翻訳の上書きを取得できませんでした: {error}"))?;
    for row in rows {
        let (name, translated) =
            row.map_err(|error| format!("タグ翻訳の上書きを読み取れませんでした: {error}"))?;
        if !name.trim().is_empty() && !translated.trim().is_empty() {
            translations.insert(name.trim().to_ascii_lowercase(), translated);
        }
    }
    Ok(translations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_the_android_translation_asset() {
        let translations = built_in_translations().expect("translation dictionary");
        assert!(translations.len() > 9_000);
        assert_eq!(
            translations.get("looking_at_viewer").map(String::as_str),
            Some("こちらを見る")
        );
        assert_eq!(
            translations.get("long_hair").map(String::as_str),
            Some("ロングヘア")
        );
    }

    #[test]
    fn database_japanese_translation_overrides_the_android_default() {
        let state = AppState::in_memory().expect("in-memory database");
        {
            let connection = state.database.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO tags(id, name, created_at, updated_at)
                     VALUES ('tag-1', 'long_hair', 1, 1)",
                    [],
                )
                .expect("insert tag");
            connection
                .execute(
                    "INSERT INTO tag_translations(tag_id, locale, display_name)
                     VALUES ('tag-1', 'ja-JP', '長い髪（上書き）')",
                    [],
                )
                .expect("insert translation override");
        }
        let translations = list_tag_translations(&state).expect("translations");
        assert_eq!(
            translations.get("long_hair").map(String::as_str),
            Some("長い髪（上書き）")
        );
    }
}
