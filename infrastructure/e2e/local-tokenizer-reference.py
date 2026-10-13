"""Prepare data-only bundles for the pinned T05 models; no downloads or remote code.

Run from the repository root after provisioning the pinned upstream JSON files and
the isolated tokenizers==0.22.1 reference wheel. Runtime uses the existing JS package.
Live count parity must still pass before using these bundles with Qyvra.
"""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path('.tools/v131-local-assets')
sys.path.insert(0, str(pathlib.Path('.tools/v131-reference').resolve()))
from tokenizers import Tokenizer

MODELS = [
    ('nomic', 'nomic-embed-text:v1.5',
     '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f'),
    ('qwen', 'qwen3:0.6b',
     '7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435'),
]

manifest = json.loads((ROOT / 'upstream-manifest.json').read_text(encoding='utf8'))
for alias, model, digest in MODELS:
    for filename in ['tokenizer.json', 'tokenizer_config.json']:
        source = ROOT / (alias + '-' + filename)
        expected = next(x for x in manifest if x['file'] == filename and
                        x['repo'].startswith('nomic-ai/' if alias == 'nomic' else 'Qwen/'))
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError('Upstream artifact integrity mismatch')
    tokenizer = Tokenizer.from_file(str(ROOT / (alias + '-tokenizer.json')))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    special = alias == 'nomic'
    bundle = dict(schemaVersion=1, model=model, modelRevision='sha256:' + digest,
                  addSpecialTokens=special, tokenizerJson=json.loads(tokenizer.to_str()),
                  tokenizerConfig=json.loads((ROOT / (alias + '-tokenizer_config.json')).read_text(encoding='utf8')))
    samples = [('ascii', 'Hello world'), ('unicode', 'Café Indonesia 中文 😀'),
               ('empty', ''), ('long', 'synthetic words ' * 128)]
    if alias == 'nomic':
        samples += [('document', 'search_document: The launch code is ORBIT-731.'),
                    ('query', 'search_query: What is the launch code?')]
    else:
        # Installed Ollama /api/show template restricted to system + user, think:false.
        framing = dict(systemPrefix='<|im_start|>system\n\n', systemSuffix='<|im_end|>\n',
                       userPrefix='<|im_start|>user\n', userSuffix=' /no_think<|im_end|>\n',
                       assistantPrefix='<|im_start|>assistant\n<think>\n\n</think>\n\n')
        messages = [dict(role='system', content='Answer from evidence.'),
                    dict(role='user', content='What is the launch code?')]
        prompt = framing['systemPrefix'] + messages[0]['content'] + framing['systemSuffix'] + \
            framing['userPrefix'] + messages[1]['content'] + framing['userSuffix'] + framing['assistantPrefix']
        bundle.update(think=False, contextLimit=4096, framing=framing,
                      promptParity=dict(messages=messages, text=prompt))
        samples += [('prompt', prompt)]
    bundle['parity'] = [dict(category=c, text=s, ids=tokenizer.encode(s, add_special_tokens=special).ids)
                        for c, s in samples]
    output = ROOT / (alias + '-bundle.json')
    output.write_text(json.dumps(bundle, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    print(alias, 'sha256', hashlib.sha256(output.read_bytes()).hexdigest(),
          'reference counts', [(p['category'], len(p['ids'])) for p in bundle['parity']])
