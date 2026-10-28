document.getElementById('grant').addEventListener('click', async () => {
  const out = document.getElementById('result');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    out.textContent = 'Microphone access granted. You can close this tab and enable the mic option in the CallShield popup.';
  } catch (e) {
    out.textContent = `Not granted: ${e.name || e}. Check the site permissions for this extension in Chrome settings.`;
  }
});
