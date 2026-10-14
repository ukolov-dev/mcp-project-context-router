import { CORE_SCHEMA, mergeTag, timestampTag, binaryTag, omapTag, pairsTag, setTag, loadAll, YAMLException } from 'js-yaml';

// Preserve v4 merge keys and timestamps with YAML 1.2 scalar rules.
const schema = CORE_SCHEMA.withTags(mergeTag, timestampTag, binaryTag, omapTag, pairsTag, setTag);

export function loadYaml(source: string): unknown {
  const documents = loadAll(source, { schema });
  if (documents.length > 1) throw new YAMLException('Expected a single YAML document.');
  return documents[0];
}
