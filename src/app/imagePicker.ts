/**
 * Opens a native file picker and hands back the chosen image as a data URI.
 * There's no asset upload backend here -- an image tile's picture lives
 * directly in the dashboard's own JSON, same as everything else on it, which
 * is why this caps the file size rather than letting a saved dashboard grow
 * without bound.
 */
export function pickImage(onData: (dataUri: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 4_000_000) {
      alert("Images are limited to 4MB -- the dashboard saves as one JSON document.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onData(String(reader.result));
    reader.readAsDataURL(file);
  };
  input.click();
}
