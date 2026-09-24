"""Gera os arquivos de dados do app (pasta dados/) a partir de duas fontes:

  1. EBER_Lista_de_Equipamentos_Consolidado.xlsx  (tags, hierarquia, tipo)
  2. checklists.json exportado pelo gerador do Book de Comissionamento (tarefas por tipo)

Uso:  python ferramentas/gerar_dados.py <lista.xlsx> <checklists.json>

IDs estáveis: o registro ferramentas/registro-ids.json guarda, para cada lista de tarefas,
o ID de cada texto de tarefa. Um texto já registrado mantém sempre o mesmo ID, mesmo que a
ordem mude no book; um texto novo recebe o próximo número livre. Assim, as marcações já
gravadas no banco nunca "mudam de item". Se um texto for apenas corrigido (erro de digitação),
edite o registro à mão para o texto novo herdar o ID antigo.
"""
import json, sys, os, re
import openpyxl

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
REG = os.path.join(AQUI, 'registro-ids.json')

AREAS = {
    '200': 'Preparo da pasta, hidrólise e resfriamento do mosto',
    '300': 'Fermentação, separação do levedo e pré-fermentação',
    '400': 'Separação de fibras, secagem e resfriamento do DDGS',
    '700': 'Utilidades — CIP e tratamento',
}
PSEUDO = {
    'A': 'Compartilhados entre equipamentos centrais',
    'B': 'Sem equipamento central identificado',
    'C': 'Grupo C', 'D': 'Grupo D',
}
SECS = {'MEC': ['MEC', 'OPE'], 'ELE': ['ELE', 'OPE'], 'INS': ['ELE', 'INS', 'OPE']}


def main(xlsx, ckjson):
    ck = json.load(open(ckjson, encoding='utf-8'))
    tipos, book, ope = ck['tipos'], ck['listas'], ck['ope']
    reg = json.load(open(REG, encoding='utf-8')) if os.path.exists(REG) else {}
    avisos = []

    def ids_para(prefixo, textos, inicial=None):
        """Devolve os IDs estáveis de uma lista de textos, atualizando o registro."""
        r = reg.setdefault(prefixo, {})
        if not r and inicial:                      # primeira geração: herda os IDs do book
            for t, i in zip(textos, inicial):
                r[t] = i
        usados = {int(v.rsplit('-', 1)[1]) for v in r.values()}
        out = []
        for t in textos:
            if t not in r:
                n = max(usados, default=0) + 1
                usados.add(n)
                r[t] = f'{prefixo}-{n:02d}'
                avisos.append(f'novo item {r[t]}: {t[:70]}')
            out.append(r[t])
        sobra = set(r) - set(textos)
        for t in sobra:
            avisos.append(f'item fora do book (mantido no registro): {r[t]}')
        return out

    listas, tipos_out, opecom = {}, {}, {}
    for cat, tp in tipos.items():
        idc = tp['idc']
        tipos_out[cat] = {'nome': tp['nome'], 'cod': tp['cod']}
        chaves = {}
        for s in SECS[tp['sec']]:
            if s == 'OPE':
                k = f'OPE-{idc}'
                src = ope[cat]['esp']
            else:
                k = 'ELE-SC' if (s == 'ELE' and tp['sec'] == 'ELE') else f'{s}-{idc}'
                src = book[k]
            if k not in listas:
                textos = [x['t'] for x in src]
                ids = ids_para(k, textos, inicial=None if s == 'OPE' else [x['id'] for x in src])
                listas[k] = [dict({'id': i, 't': x['t'], 'o': x['o']},
                                  **({'pend': 1} if x.get('b') == 'Pendência' else {}),
                                  **({'fga': 1, 'crit': x['crit']} if x.get('fga') else {}))
                             for i, x in zip(ids, src)]
            chaves[s] = k
        tipos_out[cat]['L'] = chaves
        opecom[cat] = [{'t': x['t'], 'o': x['o']} for x in ope[cat]['com']]

    json.dump({'tipos': tipos_out, 'listas': listas, 'opeCom': opecom},
              open(os.path.join(RAIZ, 'dados', 'listas.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    rows = list(openpyxl.load_workbook(xlsx, read_only=True).worksheets[0].iter_rows(values_only=True))[1:]
    resumo = []
    for area, nome in AREAS.items():
        cmap, centrais = {}, []
        for r in rows:
            if str(r[0]) != area:
                continue
            ct = r[1]
            if ct not in cmap:
                c = {'tag': ct, 'desc': PSEUDO[ct] if ct in PSEUDO else r[2], 'itens': []}
                if ct in PSEUDO:
                    c['pseudo'] = 1
                cmap[ct] = c
                centrais.append(c)
            cat = r[9]
            if cat is None:
                continue                       # linha que só declara o nó A/B
            if cat not in tipos:
                raise SystemExit(f'Tipo sem checklist no book: {cat} ({r[7]})')
            n = 0 if r[3] is None else (1 if r[5] is None else 2)
            it = {'loc': r[7], 'tag': ct if n == 0 else (r[3] if n == 1 else r[5]),
                  'desc': r[2] if n == 0 else (r[4] if n == 1 else r[6]), 'cat': cat, 'n': n}
            if not re.fullmatch(r'[A-Za-z0-9_.~:@+-]+', it['loc']):
                raise SystemExit(f'Local com caractere inválido para ID: {it["loc"]}')
            if n == 0 and ct not in PSEUDO:
                it['cen'] = 1                  # equipamento central: recebe as 7 tarefas comuns de Operação
            cmap[ct]['itens'].append(it)
        locs = [i['loc'] for c in centrais for i in c['itens']]
        assert len(locs) == len(set(locs)), f'local repetido na área {area}'
        json.dump({'area': area, 'nome': nome, 'centrais': centrais},
                  open(os.path.join(RAIZ, 'dados', f'area-{area}.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        nck = nit = 0
        for c in centrais:
            for i in c['itens']:
                for s, k in tipos_out[i['cat']]['L'].items():
                    nck += 1
                    nit += len(listas[k]) + (7 if (s == 'OPE' and i.get('cen')) else 0)
        resumo.append({'id': area, 'nome': nome, 'centrais': len(centrais), 'equip': len(locs), 'checklists': nck, 'itens': nit})

    json.dump(resumo, open(os.path.join(RAIZ, 'dados', 'areas.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(reg, open(REG, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, sort_keys=True)
    for a in resumo:
        print(f"Área {a['id']}: {a['centrais']} grupos, {a['equip']} equipamentos, {a['checklists']} checklists, {a['itens']} itens")
    novos = [a for a in avisos if a.startswith('novo')]
    print(f'{len(novos)} IDs novos atribuídos;', len(avisos) - len(novos), 'itens só no registro')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
