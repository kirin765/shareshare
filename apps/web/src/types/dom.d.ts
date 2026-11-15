export {};

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
      excludeAcceptAllOption?: boolean;
      id?: string;
      startIn?: string;
    }) => Promise<FileSystemFileHandle>;
  }
}
