const headers = {
  Authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`,
}

for (let attempt = 0; attempt < 50; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:4096/config', { headers, signal: AbortSignal.timeout(5000) })
    if (response.ok) {
      const ready = await fetch('http://127.0.0.1:4097/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENCODE_LOCAL_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      })
      if (ready.ok) process.exit(0)
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500))
}
console.error('OpenCode local API startup failed')
process.exit(1)
