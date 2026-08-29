use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{catalog, db::AppState, models::MutationResult};

const MAX_GROUP_NAME_CHARS: usize = 120;
const MAX_GROUP_MEMBERS: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroupMember {
    pub root_id: String,
    pub relative_folder: String,
    pub display_name: String,
    pub root_name: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroup {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub members: Vec<FolderGroupMember>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroupMemberInput {
    pub root_id: String,
    #[serde(default)]
    pub relative_folder: String,
}

pub fn list_folder_groups(state: &AppState) -> Result<Vec<FolderGroup>, String> {
    let connection = state.database.lock()?;
    let mut groups = {
        let mut statement = connection
            .prepare(
                "SELECT id, name, sort_order, created_at, updated_at
                 FROM folder_groups
                 ORDER BY sort_order, name COLLATE NOCASE, id",
            )
            .map_err(|error| format!("フォルダーグループを準備できませんでした: {error}"))?;
        statement
            .query_map([], |row| {
                Ok(FolderGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    members: Vec::new(),
                })
            })
            .map_err(|error| format!("フォルダーグループを取得できませんでした: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("フォルダーグループを読み込めませんでした: {error}"))?
    };
    if groups.is_empty() {
        return Ok(groups);
    }

    let mut by_group = HashMap::new();
    for (index, group) in groups.iter().enumerate() {
        by_group.insert(group.id.clone(), index);
    }
    let mut statement = connection
        .prepare(
            "SELECT gm.group_id, gm.root_id, gm.relative_folder, gm.sort_order,
                    r.display_name,
                    COALESCE(NULLIF(f.display_name, ''), r.display_name)
             FROM folder_group_members gm
             JOIN library_roots r ON r.id = gm.root_id AND r.enabled = 1
             LEFT JOIN folder_hierarchy_cache f
               ON f.root_id = gm.root_id
              AND f.relative_folder = gm.relative_folder COLLATE NOCASE
             ORDER BY gm.group_id, gm.sort_order, gm.relative_folder COLLATE NOCASE",
        )
        .map_err(|error| format!("グループのメンバーを準備できませんでした: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                FolderGroupMember {
                    root_id: row.get(1)?,
                    relative_folder: row.get(2)?,
                    sort_order: row.get(3)?,
                    root_name: row.get(4)?,
                    display_name: row.get(5)?,
                },
            ))
        })
        .map_err(|error| format!("グループのメンバーを取得できませんでした: {error}"))?;
    for row in rows {
        let (group_id, member) =
            row.map_err(|error| format!("グループのメンバーを読み込めませんでした: {error}"))?;
        if let Some(index) = by_group.get(&group_id) {
            groups[*index].members.push(member);
        }
    }
    Ok(groups)
}

pub fn save_folder_group(
    state: &AppState,
    group_id: Option<&str>,
    name: &str,
    members: &[FolderGroupMemberInput],
) -> Result<FolderGroup, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_GROUP_NAME_CHARS {
        return Err(format!(
            "グループ名は1〜{MAX_GROUP_NAME_CHARS}文字で入力してください。"
        ));
    }
    let members = normalize_members(members)?;
    if !(2..=MAX_GROUP_MEMBERS).contains(&members.len()) {
        return Err(format!(
            "フォルダーグループには2〜{MAX_GROUP_MEMBERS}件のフォルダーが必要です。"
        ));
    }

    let id = group_id
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = catalog::now_millis();
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("グループの更新を開始できませんでした: {error}"))?;

    if group_id.is_some() {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM folder_groups WHERE id = ?1)",
                [&id],
                |row| row.get(0),
            )
            .map_err(|error| format!("グループを確認できませんでした: {error}"))?;
        if !exists {
            return Err("更新するフォルダーグループが見つかりません。".to_owned());
        }
    }

    for member in &members {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM library_roots r
                    LEFT JOIN folder_hierarchy_cache f
                      ON f.root_id = r.id AND f.relative_folder = ?2 COLLATE NOCASE
                    WHERE r.id = ?1 AND r.enabled = 1
                      AND (?2 = '' OR f.root_id IS NOT NULL)
                 )",
                params![member.root_id, member.relative_folder],
                |row| row.get(0),
            )
            .map_err(|error| format!("フォルダーを確認できませんでした: {error}"))?;
        if !exists {
            return Err(format!(
                "登録済みフォルダーが見つかりません: {} / {}",
                member.root_id, member.relative_folder
            ));
        }
    }

    let duplicate_name: Option<String> = transaction
        .query_row(
            "SELECT id FROM folder_groups WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            params![name, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("グループ名を確認できませんでした: {error}"))?;
    if duplicate_name.is_some() {
        return Err("同じ名前のフォルダーグループがすでにあります。".to_owned());
    }

    let existing_sort_order = transaction
        .query_row(
            "SELECT sort_order FROM folder_groups WHERE id = ?1",
            [&id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("グループの並び順を確認できませんでした: {error}"))?;
    let sort_order = if let Some(sort_order) = existing_sort_order {
        sort_order
    } else {
        transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folder_groups",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("グループの並び順を作成できませんでした: {error}"))?
    };

    transaction
        .execute(
            "INSERT INTO folder_groups(id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
            params![id, name, sort_order, now],
        )
        .map_err(|error| format!("フォルダーグループを保存できませんでした: {error}"))?;

    // A physical folder belongs to at most one virtual group. Reassigning it
    // is atomic, and groups left with fewer than two members are removed.
    for member in &members {
        transaction
            .execute(
                "DELETE FROM folder_group_members
                 WHERE root_id = ?1 AND relative_folder = ?2 COLLATE NOCASE AND group_id <> ?3",
                params![member.root_id, member.relative_folder, id],
            )
            .map_err(|error| format!("フォルダーの所属を更新できませんでした: {error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM folder_group_members WHERE group_id = ?1",
            [&id],
        )
        .map_err(|error| format!("グループのメンバーを更新できませんでした: {error}"))?;
    for (index, member) in members.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO folder_group_members(group_id, root_id, relative_folder, sort_order)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, member.root_id, member.relative_folder, index as i64],
            )
            .map_err(|error| format!("グループへフォルダーを追加できませんでした: {error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM folder_groups
             WHERE id <> ?1
               AND (SELECT COUNT(*) FROM folder_group_members WHERE group_id = folder_groups.id) < 2",
            [&id],
        )
        .map_err(|error| format!("空になったグループを整理できませんでした: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("グループの更新を確定できませんでした: {error}"))?;
    drop(connection);

    list_folder_groups(state)?
        .into_iter()
        .find(|group| group.id == id)
        .ok_or_else(|| "保存したフォルダーグループを読み込めませんでした。".to_owned())
}

pub fn delete_folder_group(state: &AppState, group_id: &str) -> Result<MutationResult, String> {
    let affected = state
        .database
        .lock()?
        .execute("DELETE FROM folder_groups WHERE id = ?1", [group_id])
        .map_err(|error| format!("フォルダーグループを解除できませんでした: {error}"))?;
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn reorder_folder_groups(
    state: &AppState,
    ordered_ids: &[String],
) -> Result<MutationResult, String> {
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("グループの並び替えを開始できませんでした: {error}"))?;
    let existing = {
        let mut statement = transaction
            .prepare("SELECT id FROM folder_groups ORDER BY id")
            .map_err(|error| format!("グループを確認できませんでした: {error}"))?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("グループを取得できませんでした: {error}"))?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|error| format!("グループを読み込めませんでした: {error}"))?
    };
    let requested = ordered_ids.iter().cloned().collect::<HashSet<_>>();
    if requested.len() != ordered_ids.len() || requested != existing {
        return Err("並び替え対象が現在のフォルダーグループと一致しません。".to_owned());
    }
    for (index, id) in ordered_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE folder_groups SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, index as i64, catalog::now_millis()],
            )
            .map_err(|error| format!("グループを並び替えできませんでした: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("グループの並び替えを確定できませんでした: {error}"))?;
    Ok(MutationResult {
        affected: ordered_ids.len() as u64,
    })
}

fn normalize_members(
    members: &[FolderGroupMemberInput],
) -> Result<Vec<FolderGroupMemberInput>, String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(members.len());
    for member in members {
        let root_id = member.root_id.trim();
        if root_id.is_empty() {
            return Err("フォルダーの登録IDが空です。".to_owned());
        }
        let relative_folder = member
            .relative_folder
            .replace('\\', "/")
            .trim_matches('/')
            .to_owned();
        if relative_folder
            .split('/')
            .any(|part| part == "." || part == "..")
        {
            return Err("フォルダーに不正な相対パスが含まれています。".to_owned());
        }
        let key = format!(
            "{}\0{}",
            root_id.to_lowercase(),
            relative_folder.to_lowercase()
        );
        if seen.insert(key) {
            normalized.push(FolderGroupMemberInput {
                root_id: root_id.to_owned(),
                relative_folder,
            });
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_folders(state: &AppState) {
        let connection = state.database.lock().expect("database lock");
        connection
            .execute_batch(
                "INSERT INTO library_roots(id, path, display_name, enabled, created_at, updated_at)
                 VALUES ('root', 'C:\\gallery', 'Gallery', 1, 1, 1);
                 INSERT INTO folder_hierarchy_cache(
                    root_id, relative_folder, display_name, root_path, root_updated_at, refreshed_at
                 ) VALUES
                    ('root', '', 'Gallery', 'C:\\gallery', 1, 1),
                    ('root', 'a', 'A', 'C:\\gallery', 1, 1),
                    ('root', 'b', 'B', 'C:\\gallery', 1, 1),
                    ('root', 'c', 'C', 'C:\\gallery', 1, 1);",
            )
            .expect("seed folders");
    }

    #[test]
    fn folder_groups_persist_reorder_and_release() {
        let state = AppState::in_memory().expect("state");
        seed_folders(&state);
        let members = |values: &[&str]| {
            values
                .iter()
                .map(|value| FolderGroupMemberInput {
                    root_id: "root".to_owned(),
                    relative_folder: (*value).to_owned(),
                })
                .collect::<Vec<_>>()
        };
        let first =
            save_folder_group(&state, None, "First", &members(&["a", "b"])).expect("create first");
        let second = save_folder_group(&state, None, "Second", &members(&["b", "c"]))
            .expect("create second");
        let groups = list_folder_groups(&state).expect("list groups");
        assert_eq!(
            groups.len(),
            1,
            "reassigning b removes the one-member group"
        );
        assert_eq!(groups[0].id, second.id);

        let recreated = save_folder_group(&state, None, "First again", &members(&["", "a"]))
            .expect("recreate first");
        reorder_folder_groups(&state, &[recreated.id.clone(), second.id.clone()]).expect("reorder");
        let groups = list_folder_groups(&state).expect("list reordered");
        assert_eq!(groups[0].id, recreated.id);
        assert_eq!(delete_folder_group(&state, &second.id).unwrap().affected, 1);
        assert_eq!(list_folder_groups(&state).unwrap().len(), 1);
        assert_ne!(first.id, recreated.id);
    }
}
