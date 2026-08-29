import { useEffect, useState } from "react";
import {
  folderActivityChangedEvent,
  loadFolderActivity,
  type FolderActivityRecord,
} from "../services/folderActivity";

export function useFolderActivity(): FolderActivityRecord[] {
  const [records, setRecords] = useState<FolderActivityRecord[]>([]);

  useEffect(() => {
    let active = true;
    void loadFolderActivity().then((loaded) => {
      if (active) setRecords(loaded);
    });
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<FolderActivityRecord[]>).detail;
      if (Array.isArray(detail)) setRecords(detail);
    };
    window.addEventListener(folderActivityChangedEvent, handleChange);
    return () => {
      active = false;
      window.removeEventListener(folderActivityChangedEvent, handleChange);
    };
  }, []);

  return records;
}
