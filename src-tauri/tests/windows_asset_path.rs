#![cfg(windows)]

use std::{fs, path::Path};

#[test]
fn canonical_verbatim_media_path_round_trips_through_the_catalog_string() {
    let library = tempfile::tempdir().expect("temporary library");
    let media_path = library.path().join("asset # 日本語.jpg");
    let expected = b"real-file";
    fs::write(&media_path, expected).expect("write media fixture");

    let canonical_root = library
        .path()
        .canonicalize()
        .expect("canonical library root");
    let canonical_media = media_path.canonicalize().expect("canonical media path");
    assert!(canonical_media.starts_with(&canonical_root));

    let catalog_path = canonical_media
        .to_str()
        .expect("catalog paths must be Unicode");
    assert!(
        catalog_path.starts_with(r"\\?\"),
        "Windows canonicalize should expose the verbatim path form used by the catalog"
    );
    assert_eq!(
        fs::read(Path::new(catalog_path)).expect("read verbatim catalog path"),
        expected
    );

    let ordinary_path = catalog_path
        .strip_prefix(r"\\?\")
        .expect("verbatim disk path prefix");
    assert_eq!(
        fs::read(Path::new(ordinary_path)).expect("read ordinary Windows path"),
        expected
    );
}
