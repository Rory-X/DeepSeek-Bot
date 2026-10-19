// Shared setup for connector modules: which credentials their card asks for, and how a
// connect request maps onto them. A module declares `credentials: [{ name, label? }]` when
// the service needs more than one secret (ima's client id and api key); a connector with a
// single `tokenSecret` keeps working without declaring anything. Names are the DSH secret
// names, so `readSecret(name)` and the Secrets page speak the same language.
export function credentialFields(connector) {
  const declared = Array.isArray(connector?.credentials) ? connector.credentials : []
  const fields = declared
    .filter(field => field !== null && typeof field === 'object' && typeof field.name === 'string' && field.name !== '')
    .map((field) => ({
      name: field.name,
      ...(typeof field.label === 'string' && field.label !== '' ? { label: field.label } : {}),
      ...(field.required === false ? { required: false } : {}),
    }))
  if (fields.length > 0) return fields
  return typeof connector?.tokenSecret === 'string' && connector.tokenSecret !== ''
    ? [{ name: connector.tokenSecret }]
    : []
}

// The values a connect request carries, keyed by secret name. `values` is the multi-input
// form; `token` is the single-input form the older cards send. Only declared fields are
// read, every value is trimmed, and a required field left empty refuses before any request
// or write.
export function connectValues(connector, body) {
  const fields = credentialFields(connector)
  const values = {}
  for (const field of fields) {
    const raw = body?.values !== null && typeof body?.values === 'object' && Object.hasOwn(body.values, field.name)
      ? body.values[field.name]
      : fields.length === 1 && field.name === connector?.tokenSecret ? body?.token : undefined
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') {
      if (field.required === false) continue
      throw new Error(`Paste ${field.label ?? field.name} first`)
    }
    values[field.name] = value
  }
  if (Object.keys(values).length === 0) throw new Error('Paste the connector credentials first')
  return values
}
