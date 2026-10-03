"""Confere uma mudança nos dados do app ANTES de publicar.

Compara a pasta de dados que está no ar (atual) com a pasta gerada (nova) e garante que:
  1. os códigos dos itens não mudaram (listas.json idêntico);
  2. nenhum equipamento novo apareceu e nenhum equipamento que fica mudou de local, tag, tipo ou nível;
  3. todo equipamento que saiu está explicado pelo ferramentas/expansao.txt.
Com o backup JSON exportado pelo app (opcional), conta também as marcações que ficam guardadas
no banco e deixam de aparecer na tela.

Uso:  python ferramentas/conferir.py <pasta dados atual> <pasta dados nova> [backup.json]
Sai com código 0 e "RESULTADO: APROVADO" se tudo estiver certo; senão, "REPROVADO" e o motivo.
"""
import json, os, sys, filecmp

AQUI = os.path.dirname(os.path.abspath(__file__))
AREAS = ['200', '300', '400', '700']


def ler_expansao():
    p = os.path.join(AQUI, 'expansao.txt')
    if not os.path.exists(p):
        return []
    return [l.split('#', 1)[0].strip().upper() for l in open(p, encoding='utf-8') if l.split('#', 1)[0].strip()]


def explicado(loc, exclusoes):
    segs = loc.split('.')[1:]
    return any(('.' in e and (loc == e or loc.startswith(e + '.'))) or ('.' not in e and e in segs) for e in exclusoes)


def mapa(pasta):
    m = {}
    for a in AREAS:
        d = json.load(open(os.path.join(pasta, f'area-{a}.json'), encoding='utf-8'))
        for c in d['centrais']:
            for it in c['itens']:
                m[it['loc']] = (c['tag'], it['tag'], it['cat'], it['n'], it.get('cen', 0), it['desc'])
    return m


def main(atual, nova, backup=None):
    falhas, linhas = [], []
    p = linhas.append

    if not filecmp.cmp(os.path.join(atual, 'listas.json'), os.path.join(nova, 'listas.json'), shallow=False):
        falhas.append('listas.json mudou: os códigos dos itens podem ter mudado.')
    else:
        p('[OK] listas.json idêntico: nenhum código de item mudou.')

    A, N = mapa(atual), mapa(nova)
    novos = sorted(set(N) - set(A))
    alterados = sorted(l for l in set(N) & set(A) if N[l] != A[l])
    sairam = sorted(set(A) - set(N))
    exclusoes = ler_expansao()
    sem_motivo = [l for l in sairam if not explicado(l, exclusoes)]

    if novos:
        falhas.append(f'{len(novos)} equipamento(s) novo(s) apareceram (ex.: {novos[:3]}).')
    else:
        p('[OK] Nenhum equipamento novo.')
    if alterados:
        falhas.append(f'{len(alterados)} equipamento(s) que ficam mudaram de local/tag/tipo/nível (ex.: {alterados[:3]}).')
    else:
        p(f'[OK] Os {len(N)} equipamentos que ficam estão idênticos (mesmo local, tag, tipo e nível).')
    if sem_motivo:
        falhas.append(f'{len(sem_motivo)} equipamento(s) saíram sem estar no expansao.txt (ex.: {sem_motivo[:3]}).')
    else:
        p(f'[OK] Saíram {len(sairam)} equipamentos, todos explicados pelo expansao.txt.')

    if sairam:
        p('')
        p('Equipamentos que saem do app (continuam no banco):')
        for l in sairam:
            p(f'  - {l}  ({A[l][2].lower()})')

    if backup:
        b = json.load(open(backup, encoding='utf-8'))
        vis = ocu = orf = 0
        ocultos = {}
        for d in b.get('documentos', []):
            for k, v in (d.get('ck') or {}).items():
                l, _s = k.split('~')
                loc = l.replace(':', '.')
                n = sum(1 for x in (v.get('checked') or {}).values() if x is True)
                if loc in N:
                    vis += n
                elif loc in A:
                    ocu += n
                    ocultos[loc] = ocultos.get(loc, 0) + n
                else:
                    orf += n
        p('')
        p(f'Backup ({b.get("exportadoEm", "?")}, fonte: {b.get("fonte", "?")}):')
        p(f'  - itens marcados que continuam visíveis no app: {vis}')
        p(f'  - itens marcados em equipamentos que saem (ficam guardados no banco, ocultos): {ocu}')
        for loc, n in sorted(ocultos.items()):
            p(f'      {loc}: {n}')
        if orf:
            p(f'  - itens marcados em locais que já não estavam no app antes desta mudança: {orf}')

    p('')
    if falhas:
        p('RESULTADO: REPROVADO — NÃO publique.')
        for f in falhas:
            p('  * ' + f)
    else:
        p('RESULTADO: APROVADO — a mudança só retira os equipamentos listados no expansao.txt.')
    print('\n'.join(linhas))
    return 1 if falhas else 0


if __name__ == '__main__':
    if len(sys.argv) not in (3, 4):
        raise SystemExit(__doc__)
    sys.exit(main(*sys.argv[1:]))
