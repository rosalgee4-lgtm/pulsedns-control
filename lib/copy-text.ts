export async function copyText(text: string): Promise<boolean> {
  const normalizedText = text.replace(/\r\n?/g, '\n');
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalizedText);
      return true;
    } catch {
      // HTTP deployments and browser policies can reject the modern API.
      // Fall through to the synchronous user-gesture-compatible method.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = normalizedText;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.inset = '-9999px auto auto -9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
