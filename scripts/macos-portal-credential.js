ObjC.import('Foundation');
ObjC.import('Security');

// Security.framework's Core Foundation signatures are not imported precisely by
// the JXA bridge. Bind them as Objective-C-compatible objects so dictionaries
// and returned NSData values are passed without lossy pointer coercion.
ObjC.bindFunction('SecItemAdd', ['int', ['id', 'id*']]);
ObjC.bindFunction('SecItemCopyMatching', ['int', ['id', 'id*']]);
ObjC.bindFunction('SecItemDelete', ['int', ['id']]);
ObjC.bindFunction('SecItemUpdate', ['int', ['id', 'id']]);

const keychainKey = Object.freeze({
  account: $('acct'),
  class: $('class'),
  classGenericPassword: $('genp'),
  label: $('labl'),
  matchLimit: $('m_Limit'),
  matchLimitOne: $('m_LimitOne'),
  returnData: $('r_Data'),
  service: $('svce'),
  valueData: $('v_Data'),
});

function mutableDictionary() {
  return $.NSMutableDictionary.alloc.init;
}

function setValue(dictionary, key, value) {
  dictionary.setObjectForKey(value, key);
}

function keychainQuery(service, account) {
  const query = mutableDictionary();
  setValue(query, keychainKey.class, keychainKey.classGenericPassword);
  setValue(query, keychainKey.service, $(service));
  setValue(query, keychainKey.account, $(account));
  return query;
}

function readStandardInput() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return ObjC.unwrap(value).replace(/\r?\n$/, '');
}

function statusNumber(status) {
  return Number(status);
}

function assertSuccess(status, operation) {
  if (statusNumber(status) !== statusNumber($.errSecSuccess)) {
    throw new Error(`macOS Keychain failed to ${operation} the Portal credential (OSStatus ${statusNumber(status)}).`);
  }
}

function storeCredential(service, account, label) {
  const value = readStandardInput();
  if (!value) throw new Error('Portal credential input is empty.');
  const valueData = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
  const query = keychainQuery(service, account);
  const update = mutableDictionary();
  setValue(update, keychainKey.valueData, valueData);
  setValue(update, keychainKey.label, $(label));
  const updated = $.SecItemUpdate(query, update);
  if (statusNumber(updated) === statusNumber($.errSecItemNotFound)) {
    setValue(query, keychainKey.valueData, valueData);
    setValue(query, keychainKey.label, $(label));
    assertSuccess($.SecItemAdd(query, Ref('id')), 'store');
    return;
  }
  assertSuccess(updated, 'update');
}

function lookupCredential(service, account) {
  const query = keychainQuery(service, account);
  setValue(query, keychainKey.returnData, true);
  setValue(query, keychainKey.matchLimit, keychainKey.matchLimitOne);
  const result = Ref('id');
  const status = $.SecItemCopyMatching(query, result);
  if (statusNumber(status) === statusNumber($.errSecItemNotFound)) return '';
  assertSuccess(status, 'read');
  const value = $.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding);
  return ObjC.unwrap(value);
}

function deleteCredential(service, account) {
  const status = $.SecItemDelete(keychainQuery(service, account));
  if (statusNumber(status) === statusNumber($.errSecItemNotFound)) return;
  assertSuccess(status, 'delete');
}

function run(argv) {
  const [operation, service, account, label = service] = argv;
  if (!operation || !service || !account) throw new Error('Portal Keychain helper arguments are incomplete.');
  if (operation === 'store') {
    storeCredential(service, account, label);
    return '';
  }
  if (operation === 'lookup') return lookupCredential(service, account);
  if (operation === 'delete') {
    deleteCredential(service, account);
    return '';
  }
  throw new Error(`Unsupported Portal Keychain operation: ${operation}.`);
}
