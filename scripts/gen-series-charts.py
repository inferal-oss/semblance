#!/usr/bin/env python3
# Generates the "Series charts" block of ontology/components/charts.ttl (from "# --- Series charts: shared parts"
# to "# --- Gantt"): the SPARQL rules of the series charts' plan, layout, frames, points and texts, whose
# sub-selects repeat (the rows, the series, the categories, a point's words). Edit this file, not the block,
# then run it from the repository's root: python3 scripts/gen-series-charts.py
#
# Inside EXISTS, write a path from $this to an unbound variable without `*` (`p/q*` as `(p|p/q+)`): Oxigraph
# evaluates the zero-length step of such a path by scanning every term of the store (#446; test/exists-paths.test.ts checks).
TTL = 'ontology/components/charts.ttl'
_ttl = open(TTL).read()
# The series of a chart, as the bar chart's rule picks them: a declared legend, else first seen, else the chart's.
_start = _ttl.index('    { SELECT ?skey ?si ?slabel WHERE {')
SERIES = _ttl[_start:_ttl.index('    } }\n', _start) + len('    } }\n')]

ROWS = '''$this c:view ?view . ?view rs:solution ?r .
      OPTIONAL { ?r rs:index ?idx }
      OPTIONAL { $this c:categoryVariable ?cv } OPTIONAL { $this c:valueVariable ?vv } OPTIONAL { $this c:seriesVariable ?sv }
      BIND(STR(?r) AS ?rs) BIND(COALESCE(?idx, ?rs) AS ?pos)
      # A binding is <row>-<variable> (view.ttl); "~" is in no variable's name.
      BIND(IRI(CONCAT(?rs, "-", COALESCE(STR(?cv), "category"))) AS ?cb)
      BIND(IRI(CONCAT(?rs, "-", COALESCE(STR(?vv), "value"))) AS ?vb)
      BIND(IRI(CONCAT(?rs, "-", COALESCE(STR(?sv), "~"))) AS ?sb)
      LATERAL { OPTIONAL { ?cb rs:value ?c0 } } LATERAL { OPTIONAL { ?vb rs:value ?v0 } } LATERAL { OPTIONAL { ?sb rs:value ?s0 } }
      BIND(COALESCE(STR(?c0), "") AS ?cat) BIND(IF(BOUND(?sv), STR(?s0), "") AS ?ser)
      # A row the result has n times (iv:multiplicity) counts n times.
      OPTIONAL { ?r iv:multiplicity ?mult0 } BIND(COALESCE(xsd:integer(?mult0), 1) AS ?mult)'''

ROWS_XZ = ROWS + '''
      OPTIONAL { $this c:xVariable ?xvar } OPTIONAL { $this c:sizeVariable ?zvar }
      BIND(IRI(CONCAT(?rs, "-", COALESCE(STR(?xvar), "~"))) AS ?xb) BIND(IRI(CONCAT(?rs, "-", COALESCE(STR(?zvar), "~"))) AS ?zb)
      LATERAL { OPTIONAL { ?xb rs:value ?x0 } } LATERAL { OPTIONAL { ?zb rs:value ?z0 } }'''

CATEGORIES = '''{ SELECT ?cat (COUNT(DISTINCT ?cat2) AS ?ci) WHERE {
      { SELECT ?cat (MIN(?pos) AS ?cpos) WHERE {
      ''' + ROWS + '''
      } GROUP BY ?cat }
      OPTIONAL {
        $this c:view ?view2 . ?view2 rs:solution ?r2 . OPTIONAL { ?r2 rs:index ?i2 }
        OPTIONAL { $this c:categoryVariable ?cv2 } BIND(IRI(CONCAT(STR(?r2), "-", COALESCE(STR(?cv2), "category"))) AS ?cb2)
        LATERAL { OPTIONAL { ?cb2 rs:value ?c2 } } BIND(COALESCE(STR(?c2), "") AS ?cat2)
        FILTER(COALESCE(?i2, STR(?r2)) < ?cpos && ?cat2 != ?cat)
      }
    } GROUP BY ?cat }'''

def F(x):
    """A number as a custom property: plain, at most four decimals (cssNumber)."""
    return f'sx:formatNumber({x} + 0e0, "en-US", "useGrouping=false;maximumFractionDigits=4")'

LABEL = lambda node, v: f'''OPTIONAL {{ ?{v}At0 l10n:of {node} ; l10n:label ?{v}0 }}
    OPTIONAL {{ FILTER(!BOUND(?{v}0)) {node} c:label ?{v}1 FILTER(isLiteral(?{v}1)) }}
    OPTIONAL {{ ?{v}At2 l10n:of {node} ; l10n:name ?{v}2 }}
    OPTIONAL {{ FILTER(!BOUND(?{v}2)) {node} rdfs:label ?{v}3 FILTER(isLiteral(?{v}3)) }}
    BIND(STR(COALESCE(?{v}0, ?{v}1, ?{v}2, ?{v}3, REPLACE(STR({node}), "^.*[#/]", ""))) AS ?{v})'''

MESSAGE = '''OPTIONAL { $this c:view ?v . ?v sem:select ?anySelect }
  BIND(COALESCE(?v, c:none) AS ?vNode)
  LATERAL { OPTIONAL {
    FILTER(NOT EXISTS { ?vNode a rs:ResultSet })
    ''' + LABEL('?vNode', 'viewLabel') + '''
  } }
  OPTIONAL { ?emptyAt l10n:of $this ; l10n:emptyText ?e0 }
  OPTIONAL { FILTER(!BOUND(?e0)) $this c:emptyText ?e1 FILTER(isLiteral(?e1)) }
  BIND(IF(!BOUND(?v), "No view.",
       IF(BOUND(?viewLabel), CONCAT(?viewLabel, " is not a maintained view (iv:View, iv:materialize iv:Graph)."),
       IF(NOT EXISTS { ?v rs:solution ?anyRow }, STR(COALESCE(?e0, ?e1)), ?unset))) AS ?message)'''

def MEASURES(chart, y, x, z):
    """A point's x and size in words around its value (measures, series.ts): ?measures. Needs ?locale and ?unit."""
    return f'''OPTIONAL {{ ?xLabelAt l10n:of {chart} ; l10n:xLabel ?xLabel0 }}
  OPTIONAL {{ FILTER(!BOUND(?xLabel0)) {chart} c:xLabel ?xLabel1 FILTER(isLiteral(?xLabel1)) }}
  OPTIONAL {{ {chart} c:xVariable ?xLabel2 }}
  OPTIONAL {{ ?zLabelAt l10n:of {chart} ; l10n:sizeLabel ?zLabel0 }}
  OPTIONAL {{ FILTER(!BOUND(?zLabel0)) {chart} c:sizeLabel ?zLabel1 FILTER(isLiteral(?zLabel1)) }}
  OPTIONAL {{ {chart} c:sizeVariable ?zLabel2 }}
  BIND(IF(BOUND({x}), CONCAT(COALESCE(STR(?xLabel0), STR(?xLabel1), STR(?xLabel2), ""), " ", sx:formatNumber({x}, ?locale, "maximumFractionDigits=2"), ", "), "") AS ?xPart)
  BIND(IF(BOUND({z}), CONCAT(", ", COALESCE(STR(?zLabel0), STR(?zLabel1), STR(?zLabel2), ""), " ", sx:formatNumber({z}, ?locale, "maximumFractionDigits=2")), "") AS ?zPart)
  BIND(CONCAT(?xPart, sx:formatNumber({y}, ?locale, "maximumFractionDigits=2"), IF(?unit = "", "", CONCAT(" ", ?unit)), ?zPart) AS ?measures)'''

ANN = '''?viewer l10n:formatLocale ?locale .
    $this c:annotation ?ann . FILTER(isIRI(?ann))
    OPTIONAL { ?ann c:at ?annAt0 } OPTIONAL { ?ann c:fromValue ?annFrom0 } OPTIONAL { ?ann c:toValue ?annTo0 }
    BIND(xsd:double(?annAt0) AS ?annAt) BIND(xsd:double(?annFrom0) AS ?annFrom) BIND(xsd:double(?annTo0) AS ?annTo)
    OPTIONAL { ?annUnitAt l10n:of $this ; l10n:unit ?annU0 }
    OPTIONAL { FILTER(!BOUND(?annU0)) $this c:unit ?annU1 FILTER(isLiteral(?annU1)) } BIND(COALESCE(STR(?annU0), STR(?annU1), "") AS ?annUnit)
    ''' + LABEL('?ann', 'annLabel') + '''
    BIND(IF(BOUND(?annAt), sx:formatNumber(?annAt, ?locale, "maximumFractionDigits=2"),
      IF(BOUND(?annFrom) && BOUND(?annTo), CONCAT(sx:formatNumber(?annFrom, ?locale, "maximumFractionDigits=2"), " – ", sx:formatNumber(?annTo, ?locale, "maximumFractionDigits=2")), ?unset)) AS ?annValue)
    FILTER(BOUND(?annValue))
    BIND(CONCAT(?annLabel, ": ", ?annValue, IF(?annUnit = "", "", CONCAT(" ", ?annUnit))) AS ?annWords)
    BIND(CONCAT("\\\\u0001n", STR(COALESCE(?annAt, ?annFrom, 0)), "\\\\u0001s", STR(?ann)) AS ?annKey)
    BIND(CONCAT(STR($this), "/~annotation-", SUBSTR(MD5(STR(?ann)), 1, 8)) AS ?annId)'''
HAS_ANN = '''EXISTS { $this c:annotation ?a0 FILTER(isIRI(?a0)) { ?a0 c:at ?x0 FILTER(isNumeric(xsd:double(?x0))) } UNION { ?a0 c:fromValue ?f0 ; c:toValue ?t0 FILTER(isNumeric(xsd:double(?f0)) && isNumeric(xsd:double(?t0))) } }'''

HEAD = '''CONSTRUCT {
  ?el a ?tag ; rdfhtml:class ?cls ; rdfhtml:style ?style ; rdfhtml:type ?type ; rdfhtml:tabIndex ?tabindex ; rdfhtml:attribute ?attr ; sem:orderKey ?key ; sem:tooltip ?tip ; rdfhtml:hasChild ?textNode .
  ?attr a rdfhtml:Attribute ; rdfhtml:attributeName ?an ; rdfhtml:attributeValue ?av .
  ?parent rdfhtml:hasChild ?el .
  ?shownRoot sem:renders $this .
  ?textNode a rdfhtml:Text ; rdfhtml:data ?data ; sem:orderKey ?textKey .
}'''

POINTS = '''{ SELECT ?p ?si ?ci ?v (SUM(COALESCE(?ov, 0e0)) AS ?below) WHERE {
      ?p a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?si ; c:categoryIndex ?ci ; c:value ?v .
      OPTIONAL { ?o a c:ChartPoint ; c:inChart $this ; c:categoryIndex ?ci ; c:seriesIndex ?osi ; c:value ?ov . FILTER(?osi < ?si) }
    } GROUP BY ?p ?si ?ci ?v }'''

def renamed(text, suffix, names):
    import re
    for n in names:
        text = re.sub(r'\?' + n + r'\b', '?' + n + suffix, text)
    return text

POINTS_NEXT = renamed(POINTS, 'N', ['p', 'si', 'ci', 'v', 'below', 'o', 'osi', 'ov'])
POINTS_SCALE = renamed(POINTS, 'S', ['p', 'si', 'ci', 'v', 'below', 'o', 'osi', 'ov'])

out = []
out.append('''# --- Series charts: shared parts -------------------------------------------------------------------
# A series chart reads a maintained view's rows in long form (as a bar chart does: category, series,
# value) through two building blocks. c:SeriesPlan mints its series (<chart>/~series-<md5 of the key>,
# c:ChartSeries: the legend's items, components placed in <chart>/~legend), its categories
# (<chart>/~category-<md5>, c:ChartCategory, in the order first seen) and its points (<chart>/~point-
# <md5 of the series>-<md5 of the category>, c:ChartPoint and the kind's c:pointClass: the sum of the
# values of the rows of a shown series and category, placed in <chart>/~marks). c:SeriesLayout adds
# what a point needs from the others: its stack base (c:base, when the chart is c:stacked), the next
# point of its series (c:nextValue, c:nextBase), the first tab stop (c:first), and the value scale
# (<chart>/~scale, c:ValueScale: a step of 1, 2 or 5 × 10ⁿ, about five, its ends on steps, with ticks).
# The frame writes the scale as custom properties (--lo, --hi, --n categories) and each point its own
# (--i, --v, --b, --nv, --nb, --color): the theme places the marks, so a new scale re-renders the frame,
# a changed row its point. A series hidden by the legend (c:hiddenSeries, its key) has no points.
# Numbers in custom properties are written plainly to four decimals, so no engine's float noise shows.

c:SeriesChart a owl:Class ; rdfs:subClassOf c:RowChart ;
    rdfs:comment "A row chart drawn from minted series, categories and points (c:SeriesPlan, c:SeriesLayout); its kinds say how a point is drawn (c:pointClass)."@en ;
    key:navigation c:ChartNavigation .
c:AxisChart a owl:Class ; rdfs:subClassOf c:SeriesChart ;
    rdfs:comment "A series chart on a value axis (gridlines and ticks) over its categories, with a legend."@en .
c:ChartNavigation a key:Navigation ; key:items ".sem-point" ; key:orientation key:Horizontal .
c:ChartSeries a owl:Class ; rdfs:subClassOf sem:Component ;
    rdfs:comment "Internal: a series of a series chart (c:inChart), minted by c:SeriesPlan: its legend item."@en ;
    sem:slug "chart-series" .
c:ChartCategory a owl:Class ; rdfs:comment "Derived: a category of a series chart, c:index in the order first seen."@en .
c:ChartPoint a owl:Class ; rdfs:subClassOf sem:Component ;
    rdfs:comment "Internal: a value of a series for a category, minted by c:SeriesPlan; the chart's kind (c:pointClass) draws it."@en .
c:ValueScale a owl:Class ; rdfs:comment "Derived: a value axis's range (c:min, c:max) and its ticks (c:tick, each c:at a value)."@en .
c:pointClass a owl:ObjectProperty ; rdfs:domain owl:Class ; rdfs:comment "On a series chart's class: the class of the points it mints (direct types only)."@en .
c:stacked a owl:DatatypeProperty ; rdfs:range xsd:boolean ; rdfs:comment "Series stack: a point starts where the earlier shown series end in its category."@en .
c:hiddenSeries a owl:DatatypeProperty ; rdfs:comment "The key of a series the legend has hidden."@en .
c:seriesHidden a owl:DatatypeProperty ; rdfs:range xsd:boolean ; rdfs:comment "Derived: a legend's series is hidden (c:hiddenSeries); not c:hidden, which takes a component out of view."@en .
c:valueScale a owl:ObjectProperty ; rdfs:range c:ValueScale .
c:series a owl:ObjectProperty ; rdfs:comment "Derived: a point's series."@en .
c:category a owl:DatatypeProperty ; rdfs:comment "Derived: a point's category."@en .
c:value a owl:DatatypeProperty .
c:seriesIndex a owl:DatatypeProperty . c:categoryIndex a owl:DatatypeProperty . c:index a owl:DatatypeProperty .
c:base a owl:DatatypeProperty . c:nextValue a owl:DatatypeProperty . c:nextBase a owl:DatatypeProperty .
c:first a owl:DatatypeProperty ; rdfs:range xsd:boolean .
c:min a owl:DatatypeProperty . c:max a owl:DatatypeProperty .
# Dual axes and annotations. A declared legend's series on the secondary axis (c:axis c:SecondaryAxis) is
# scaled on its own (c:secondaryScale, ticks at the plot's inline end) and says c:secondaryUnit. A chart's
# annotations (c:annotation) are thresholds (c:Threshold, c:at) and marked ranges (c:MarkedRange,
# c:fromValue, c:toValue), named by their labels; the primary scale includes their values.
c:axis a owl:ObjectProperty ; rdfs:range c:Axis ; rdfs:comment "On a legend's series: the value axis it is drawn on (default the primary)."@en .
c:Axis a owl:Class . c:PrimaryAxis a c:Axis . c:SecondaryAxis a c:Axis ; rdfs:comment "The value axis at the plot's inline end."@en .
c:secondaryUnit a owl:DatatypeProperty ; rdfs:comment "The unit of the values on the secondary axis."@en .
c:secondary a owl:DatatypeProperty ; rdfs:range xsd:boolean ; rdfs:comment "Derived: a series, or a point, is on the secondary axis."@en .
c:secondaryScale a owl:ObjectProperty ; rdfs:range c:ValueScale ; rdfs:comment "Derived: the secondary axis's scale."@en .
c:annotation a owl:ObjectProperty ; rdfs:range c:Annotation ; rdfs:comment "A threshold or a marked range drawn on a chart's plot."@en .
c:Annotation a owl:Class ; rdfs:comment "A mark on a chart's value axis, named by its label."@en .
c:Threshold a owl:Class ; rdfs:subClassOf c:Annotation ; rdfs:comment "A line at a value (c:at): a target, a budget, a limit."@en .
c:MarkedRange a owl:Class ; rdfs:subClassOf c:Annotation ; rdfs:comment "A band from c:fromValue to c:toValue: a normal range, a period of note."@en .
c:fromValue a owl:DatatypeProperty . c:toValue a owl:DatatypeProperty .

c:SeriesPlan a sem:Rendering ; sem:targets c:SeriesChart ; sem:stratum -2 ; sem:inputOnly true ;
    sem:follows c:dataset , c:hiddenSeries , ( c:view rs:solution rs:binding ) , ( c:legend [ sem:zeroOrMore rdf:rest ] rdf:first ) .
c:SeriesPlan-fn a sem:Rule ; sem:implements c:SeriesPlan ; sem:function "series:plan" .
c:SeriesPlan-sparql a sem:Rule ; sem:implements c:SeriesPlan ; sem:bulk false ;
    sem:construct """
CONSTRUCT {
  ?node a ?type , ?type2 ; c:inChart $this ; c:key ?key ; c:label ?label ; c:index ?index ; c:seriesHidden ?hidden ; c:secondary ?secondary ; sem:orderKey ?okey ;
    c:series ?seriesNode ; c:category ?category ; c:value ?value ; c:x ?xOut ; c:size ?zOut ; c:seriesIndex ?seriesIndex ; c:categoryIndex ?categoryIndex .
  ?container rdfhtml:hasChild ?node .
}
WHERE {
  $this a/rdfs:subClassOf* c:SeriesChart ; c:view ?theView .
  ?theView a rs:ResultSet .
  # A kind with a plan of its own (c:ownPlan: a histogram's bins, a box plot's boxes) is left to it.
  FILTER NOT EXISTS { $this (a|a/rdfs:subClassOf+) ?ownKind . ?ownKind c:ownPlan true }
  BIND(STR($this) AS ?me)
  LATERAL {
  {
    # A series per legend item: declared (c:legend), else the series variable's values as first seen, else one named by the chart.
''' + SERIES + '''    BIND(IRI(CONCAT(?me, "/~series-", SUBSTR(MD5(?skey), 1, 8))) AS ?node)
    BIND(c:ChartSeries AS ?type) BIND(?skey AS ?key) BIND(?slabel AS ?label) BIND(?si AS ?index)
    BIND(IF(EXISTS { $this c:hiddenSeries ?h FILTER(STR(?h) = ?skey) }, true, ?unset) AS ?hidden)
    BIND(IF(EXISTS { $this (c:legend/rdf:first|c:legend/rdf:rest+/rdf:first) ?axisSeries . ?axisSeries c:axis c:SecondaryAxis . OPTIONAL { ?axisSeries c:key ?axisKey } FILTER(COALESCE(STR(?axisKey), STR(?axisSeries)) = ?skey) }, true, ?unset) AS ?secondary)
    BIND(CONCAT("\\\\u0001n", STR(?si)) AS ?okey)
    BIND(IRI(CONCAT(?me, "/~legend")) AS ?container)
  } UNION {
    # A category per value of the category variable, in the order first seen.
    ''' + CATEGORIES + '''
    BIND(IRI(CONCAT(?me, "/~category-", SUBSTR(MD5(?cat), 1, 8))) AS ?node)
    BIND(c:ChartCategory AS ?type) BIND(?ci AS ?index) BIND(?cat AS ?label)
  } UNION {
    # A point per shown series and category with a value: the sum of its rows'.
    { SELECT ?ser ?cat (SUM(?x * ?mult) AS ?sum) (COUNT(?xn) AS ?xcount) (SUM(COALESCE(?xn * ?mult, 0e0)) AS ?xsum) (SUM(COALESCE(?zn * ?mult, 0e0)) AS ?zsum) WHERE {
      ''' + ROWS_XZ + '''
      BIND(xsd:double(?v0) AS ?x) FILTER(BOUND(?x) && BOUND(?ser))
      BIND(xsd:double(?x0) AS ?xn) BIND(xsd:double(?z0) AS ?zn)
    } GROUP BY ?ser ?cat }
    # A chart with an x variable has no point without an x.
    BIND(EXISTS { $this c:xVariable ?anyX } AS ?hasX)
    FILTER(!?hasX || ?xcount > 0)
    BIND(IF(?hasX, ?xsum, ?unset) AS ?xOut) BIND(IF(EXISTS { $this c:sizeVariable ?anyZ }, ?zsum, ?unset) AS ?zOut)
''' + SERIES + '''    FILTER(?skey = ?ser)
    FILTER NOT EXISTS { $this c:hiddenSeries ?h FILTER(STR(?h) = ?skey) }
    ''' + CATEGORIES + '''
    BIND(IRI(CONCAT(?me, "/~point-", SUBSTR(MD5(?ser), 1, 8), "-", SUBSTR(MD5(?cat), 1, 8))) AS ?node)
    BIND(c:ChartPoint AS ?type)
    OPTIONAL { $this a ?kind . ?kind c:pointClass ?type2 }
    BIND(IRI(CONCAT(?me, "/~series-", SUBSTR(MD5(?ser), 1, 8))) AS ?seriesNode)
    BIND(?cat AS ?category) BIND(?sum AS ?value) BIND(?si AS ?seriesIndex) BIND(?ci AS ?categoryIndex)
    BIND(IF(EXISTS { $this (c:legend/rdf:first|c:legend/rdf:rest+/rdf:first) ?axisSeries . ?axisSeries c:axis c:SecondaryAxis . OPTIONAL { ?axisSeries c:key ?axisKey } FILTER(COALESCE(STR(?axisKey), STR(?axisSeries)) = ?skey) }, true, ?unset) AS ?secondary)

    BIND(CONCAT("\\\\u0001n", STR(?si), "\\\\u0001n", STR(?ci)) AS ?okey)
    BIND(IRI(CONCAT(?me, "/~marks")) AS ?container)
  }
  }
}""" .

c:SeriesLayout a sem:Rendering ; sem:targets c:SeriesChart ; sem:stratum -1 ; sem:readsMinted true ;
    sem:follows c:annotation , ( c:annotation c:at ) , ( c:annotation c:fromValue ) , ( c:annotation c:toValue ) , ( c:annotation rdfs:label ) .
c:SeriesLayout-fn a sem:Rule ; sem:implements c:SeriesLayout ; sem:function "series:layout" .
c:SeriesLayout-sparql a sem:Rule ; sem:implements c:SeriesLayout ; sem:needsExtension sx:Math , sx:Locale ; sem:bulk false ;
    sem:construct """
CONSTRUCT {
  ?p c:base ?base ; c:rank ?rank ; c:nextValue ?nv ; c:nextBase ?nb ; c:first ?first ; c:from ?from ; c:share ?share .
  ?chart ?scaleLink ?scale ; c:sizeMax ?zmax ; c:total ?total . ?scale a c:ValueScale ; c:min ?min ; c:max ?max ; c:tick ?tick . ?tick c:at ?at ; c:index ?k .
}
WHERE {
  $this a/rdfs:subClassOf* c:SeriesChart .
  BIND(EXISTS { $this c:stacked true } AS ?stacked)
  LATERAL {
  {
    # Each point's base, the next point of its series, and the first tab stop (the least series, then category).
    ''' + POINTS + '''
    BIND(IF(?stacked, ?below, 0e0) AS ?base)
    OPTIONAL { ''' + POINTS_NEXT + ''' FILTER(?siN = ?si && ?ciN = ?ci + 1) }
    BIND(?vN AS ?nv) BIND(IF(BOUND(?vN), IF(?stacked, ?belowN, 0e0), ?unset) AS ?nb)
    { SELECT (MIN(?si3 * 1000000 + ?ci3) AS ?firstKey) WHERE { ?p3 a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?si3 ; c:categoryIndex ?ci3 } }
    BIND(IF(?si * 1000000 + ?ci = ?firstKey, true, ?unset) AS ?first)
    # Its rank: how many shown series with points come before its series (a group's place).
    { SELECT ?si (COUNT(DISTINCT ?siBefore) AS ?rank) WHERE {
      ?pr a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?si .
      OPTIONAL { ?pb a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?siBefore FILTER(?siBefore < ?si) }
    } GROUP BY ?si }
  } UNION {
    # The value scale, from the least to the greatest end of any point; the x scale over their x.
    {
      { SELECT (MIN(?lo1) AS ?lo0) (MAX(?hi1) AS ?hi0) WHERE {
        {
        ''' + POINTS_SCALE + '''
        # A point's ends: its value, and its base when it is stacked on others.
        BIND(EXISTS { $this c:stacked true } AS ?stackedS)
        BIND(IF(?stackedS, ?belowS, 0e0) AS ?b)
        # A box's whiskers are ends too.
        OPTIONAL { ?pS c:low ?lowS ; c:high ?highS }
        BIND(IF(?stackedS && ?b < ?b + ?vS, ?b, ?b + ?vS) AS ?lo2) BIND(IF(?stackedS && ?b > ?b + ?vS, ?b, ?b + ?vS) AS ?hi2)
        BIND(IF(BOUND(?lowS) && ?lowS < ?lo2, ?lowS, ?lo2) AS ?lo1) BIND(IF(BOUND(?highS) && ?highS > ?hi2, ?highS, ?hi2) AS ?hi1)
        FILTER NOT EXISTS { ?pS c:secondary true }
        } UNION {
          # The annotations' values, so a threshold or a marked range is in view.
          $this c:annotation ?an . VALUES ?ap { c:at c:fromValue c:toValue } ?an ?ap ?av .
          BIND(xsd:double(?av) AS ?lo1) BIND(?lo1 AS ?hi1)
        }
      } }
      BIND(c:valueScale AS ?scaleLink) BIND("scale" AS ?scaleLocal)
    } UNION {
      # Points of a series on the secondary axis (c:axis c:SecondaryAxis) have a scale of their own.
      { SELECT (MIN(?lo1) AS ?lo0) (MAX(?hi1) AS ?hi0) WHERE {
        ''' + POINTS_SCALE + '''
        # A point's ends: its value, and its base when it is stacked on others.
        BIND(EXISTS { $this c:stacked true } AS ?stackedS)
        BIND(IF(?stackedS, ?belowS, 0e0) AS ?b)
        # A box's whiskers are ends too.
        OPTIONAL { ?pS c:low ?lowS ; c:high ?highS }
        BIND(IF(?stackedS && ?b < ?b + ?vS, ?b, ?b + ?vS) AS ?lo2) BIND(IF(?stackedS && ?b > ?b + ?vS, ?b, ?b + ?vS) AS ?hi2)
        BIND(IF(BOUND(?lowS) && ?lowS < ?lo2, ?lowS, ?lo2) AS ?lo1) BIND(IF(BOUND(?highS) && ?highS > ?hi2, ?highS, ?hi2) AS ?hi1)
        FILTER EXISTS { ?pS c:secondary true }
      } }
      BIND(c:secondaryScale AS ?scaleLink) BIND("scale2" AS ?scaleLocal)
    } UNION {
      { SELECT (MIN(?px) AS ?lo0) (MAX(?px) AS ?hi0) WHERE { ?pxn a c:ChartPoint ; c:inChart $this ; c:x ?px } }
      BIND(c:xScale AS ?scaleLink) BIND("xscale" AS ?scaleLocal)
    }
    FILTER(BOUND(?lo0))
    BIND($this AS ?chart)
    # With zero, unless the kind says otherwise (c:fromZero false).
    BIND(NOT EXISTS { $this (a|a/rdfs:subClassOf+) ?zeroKind . ?zeroKind c:fromZero false } AS ?fromZero)
    BIND(IF(?fromZero && ?lo0 > 0, 0e0, ?lo0) AS ?lo) BIND(IF(?fromZero && ?hi0 < 0, 0e0, ?hi0) AS ?hi)
    BIND(IF(?hi - ?lo > 0, ?hi - ?lo, 1e0) / 5 AS ?raw)
    BIND(sx:pow(10, FLOOR(sx:log10(?raw))) AS ?mag)
    BIND(?raw / ?mag AS ?ratio)
    BIND(IF(?ratio <= 1, 1, IF(?ratio <= 2, 2, IF(?ratio <= 5, 5, 10))) * ?mag AS ?step)
    BIND(FLOOR(?lo / ?step) * ?step AS ?min)
    BIND(CEIL(?hi / ?step) * ?step AS ?max0) BIND(IF(?max0 >= ?min + ?step, ?max0, ?min + ?step) AS ?max)
    BIND(ROUND((?max - ?min) / ?step) AS ?count)
    BIND(IRI(CONCAT(STR($this), "/~", ?scaleLocal)) AS ?scale)
    LATERAL { OPTIONAL {
      VALUES ?k { 0 1 2 3 4 5 6 7 8 9 10 11 12 }
      FILTER(?k <= ?count)
      BIND(IRI(CONCAT(STR($this), "/~", ?scaleLocal, "-tick-", STR(?k))) AS ?tick) BIND(?min + ?k * ?step AS ?at)
    } }
  } UNION {
    # The greatest size, when the chart has sizes.
    { SELECT (MAX(?pz) AS ?zmax) WHERE { ?pzn a c:ChartPoint ; c:inChart $this ; c:size ?pz } }
    FILTER(BOUND(?zmax))
    BIND($this AS ?chart)
  } UNION {
    # A polar kind (c:polar true, a pie): the positive total, each point's share of it, and where it starts (the shares before it).
    FILTER EXISTS { $this (a|a/rdfs:subClassOf+) ?polarKind . ?polarKind c:polar true }
    FILTER EXISTS { ?anyPoint a c:ChartPoint ; c:inChart $this }
    { SELECT (SUM(IF(?tv > 0, ?tv, 0e0)) AS ?total0) WHERE { ?tp a c:ChartPoint ; c:inChart $this ; c:value ?tv } }
    LATERAL {
      { BIND($this AS ?chart) BIND(?total0 AS ?total) }
      UNION {
        FILTER(?total0 > 0)
        { SELECT ?p ?pv (SUM(COALESCE(?bv, 0e0)) AS ?cum) WHERE {
          ?p a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?psi ; c:categoryIndex ?pci ; c:value ?pv .
          OPTIONAL {
            ?q a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?qsi ; c:categoryIndex ?qci ; c:value ?qv
            FILTER(?qsi * 1000000 + ?qci < ?psi * 1000000 + ?pci) BIND(IF(?qv > 0, ?qv, 0e0) AS ?bv)
          }
        } GROUP BY ?p ?pv }
        BIND(?cum / ?total0 AS ?from) BIND(IF(?pv > 0, ?pv, 0e0) / ?total0 AS ?share)
      }
    }
  }
  }
}""" .
''')

out.append('''
c:AxisChartRendering a sem:Rendering ; sem:targets c:AxisChart ; sem:modality mod:Screen ; sem:stratum 0 ; sem:readsMinted true ;
    sem:follows c:dataset , c:view , c:annotation , ( c:annotation c:at ) , ( c:annotation c:fromValue ) , ( c:annotation c:toValue ) , ( c:annotation rdfs:label ) .
c:AxisChartRendering-fn a sem:Rule ; sem:implements c:AxisChartRendering ; sem:function "series:frame" .
c:AxisChartRendering-sparql a sem:Rule ; sem:implements c:AxisChartRendering ; sem:needsExtension sx:Locale ; sem:bulk false ;
    sem:construct """
''' + HEAD + '''
WHERE {
  $this a/rdfs:subClassOf* c:AxisChart .
  BIND(STR($this) AS ?me)
  BIND(IRI(CONCAT(?me, "/~root")) AS ?root)
  ''' + MESSAGE + '''
  LATERAL {
  {
    FILTER(BOUND(?message))
    BIND(?root AS ?el) BIND(?root AS ?shownRoot) BIND(rdfhtml:P AS ?tag) BIND("sem-empty" AS ?cls)
    BIND(IRI(CONCAT(?me, "/~empty")) AS ?textNode) BIND(?message AS ?data)
  } UNION {
    # The figure (the scale and the number of categories as custom properties): the plot, its ticks and marks, the categories, the legend.
    FILTER(!BOUND(?message))
    ''' + LABEL('$this', 'label') + '''
    OPTIONAL { $this c:valueScale ?scale . ?scale a c:ValueScale ; c:min ?min ; c:max ?max }
    OPTIONAL { $this c:xScale ?xscale . ?xscale a c:ValueScale ; c:min ?xmin ; c:max ?xmax }
    OPTIONAL { $this c:secondaryScale ?scale2 . ?scale2 a c:ValueScale ; c:min ?min2 ; c:max ?max2 }
    BIND(''' + HAS_ANN + ''' AS ?annotated)
    OPTIONAL { $this c:sizeMax ?zmax }
    { SELECT (COUNT(?cn) AS ?n) WHERE { ?cn a c:ChartCategory ; c:inChart $this } }
    { SELECT (COUNT(DISTINCT ?psi) AS ?k) WHERE { OPTIONAL { ?pp a c:ChartPoint ; c:inChart $this ; c:seriesIndex ?psi } } }
    VALUES (?local ?tag0 ?cls0 ?parentLocal ?key0) {
      ("root" rdfhtml:Figure UNDEF UNDEF UNDEF) ("plot" rdfhtml:Div "sem-chart-plot" "root" 0) ("ticks" rdfhtml:Div "sem-chart-ticks" "plot" 0)
      ("ticks2" rdfhtml:Div "sem-chart-ticks sem-secondary" "plot" 0.5) ("annotations" rdfhtml:Div "sem-chart-annotations" "plot" 0.7)
      ("marks" rdfhtml:Ol "sem-chart-marks" "plot" 1) ("categories" rdfhtml:Div "sem-chart-categories" "root" 1) ("xticks" rdfhtml:Div "sem-chart-xticks" "root" 1)
      ("legend" rdfhtml:Ul "sem-legend" "root" 2) }
    # Below the plot: the x scale's ticks when the chart has one, else its categories.
    FILTER(IF(?local = "xticks", BOUND(?xscale), IF(?local = "categories", !BOUND(?xscale), IF(?local = "ticks2", BOUND(?scale2), IF(?local = "annotations", ?annotated, true)))))
    BIND(IRI(CONCAT(?me, "/~", ?local)) AS ?el) BIND(?tag0 AS ?tag) BIND(?cls0 AS ?cls) BIND(?key0 AS ?key)
    BIND(IF(?local = "root", ?root, ?unset) AS ?shownRoot)
    BIND(IF(BOUND(?parentLocal), IRI(CONCAT(?me, "/~", ?parentLocal)), ?unset) AS ?parent)
    BIND(IF(?local = "root", CONCAT(IF(BOUND(?min), CONCAT("--lo: ", ''' + F('?min') + ''', "; --hi: ", ''' + F('?max') + ''', "; "), ""),
      IF(BOUND(?min2), CONCAT("--lo2: ", ''' + F('?min2') + ''', "; --hi2: ", ''' + F('?max2') + ''', "; "), ""),
      IF(BOUND(?xmin), CONCAT("--xlo: ", ''' + F('?xmin') + ''', "; --xhi: ", ''' + F('?xmax') + ''', "; "), ""),
      IF(BOUND(?zmax), CONCAT("--zmax: ", ''' + F('?zmax') + ''', "; "), ""), "--n: ", STR(?n), "; --k: ", STR(?k)), ?unset) AS ?style)
    LATERAL { OPTIONAL {
      VALUES (?forLocal ?an ?av0) { ("ticks" "aria-hidden" "true") ("marks" "aria-label" UNDEF) ("categories" "aria-hidden" "true") ("xticks" "aria-hidden" "true") ("ticks2" "aria-hidden" "true") }
      FILTER(?forLocal = ?local)
      BIND(IRI(CONCAT(?me, "/~", ?local, "-", ?an)) AS ?attr) BIND(COALESCE(?av0, ?label) AS ?av)
    } }
  } UNION {
    # A tick per step of a scale (the value scale's, the x scale's), at its value, in the viewer's locale.
    FILTER(!BOUND(?message))
    ?viewer l10n:formatLocale ?locale .
    VALUES (?scaleLink ?tickLocal ?ticksLocal ?tickClass) { (c:valueScale "tick" "ticks" "sem-chart-tick") (c:xScale "xtick" "xticks" "sem-chart-xtick") (c:secondaryScale "tick2" "ticks2" "sem-chart-tick") }
    $this ?scaleLink ?scale . ?scale a c:ValueScale ; c:tick ?tick . ?tick c:at ?at ; c:index ?k .
    BIND(IRI(CONCAT(?me, "/~", ?tickLocal, "-", STR(?k))) AS ?el) BIND(rdfhtml:Span AS ?tag) BIND(?tickClass AS ?cls) BIND(?k AS ?key)
    BIND(IRI(CONCAT(?me, "/~", ?ticksLocal)) AS ?parent) BIND(CONCAT("--at: ", ''' + F('?at') + ''') AS ?style)
    BIND(IRI(CONCAT(?me, "/~", ?tickLocal, "-", STR(?k), "-text")) AS ?textNode) BIND(sx:formatNumber(?at + 0e0, ?locale, "maximumFractionDigits=4") AS ?data)
  } UNION {
    # The annotations, in order of their values: a threshold line at its value, a marked range as a band, each with its words.
    FILTER(!BOUND(?message))
    ''' + ANN + '''
    BIND(IRI(?annId) AS ?el) BIND(rdfhtml:Span AS ?tag) BIND(?annKey AS ?key)
    BIND(IF(BOUND(?annAt), "sem-threshold", "sem-marked-range") AS ?cls)
    BIND(IRI(CONCAT(?me, "/~annotations")) AS ?parent)
    BIND(IF(BOUND(?annAt), CONCAT("--at: ", ''' + F('?annAt') + '''), CONCAT("--from: ", ''' + F('?annFrom') + ''', "; --to: ", ''' + F('?annTo') + ''')) AS ?style)
    BIND(IRI(CONCAT(?annId, "-text")) AS ?textNode) BIND(?annWords AS ?data)
  } UNION {
    # The categories, each at its place (a chart with an x scale has none below it).
    FILTER(!BOUND(?message))
    FILTER NOT EXISTS { $this c:xScale ?anyXScale }
    ?cn a c:ChartCategory ; c:inChart $this ; c:index ?i ; c:label ?cl .
    # A bin is named by its bounds, in the viewer's locale.
    OPTIONAL { ?cn c:lower ?clo ; c:upper ?cup . ?viewer l10n:formatLocale ?locale }
    BIND(IRI(CONCAT(?me, "/~cat-", STR(?i))) AS ?el) BIND(rdfhtml:Span AS ?tag) BIND(?i AS ?key)
    BIND(IRI(CONCAT(?me, "/~categories")) AS ?parent) BIND(CONCAT("--i: ", STR(?i)) AS ?style)
    BIND(IRI(CONCAT(?me, "/~cat-", STR(?i), "-text")) AS ?textNode)
    BIND(IF(BOUND(?clo), CONCAT(sx:formatNumber(?clo + 0e0, ?locale, "maximumFractionDigits=4"), " – ", sx:formatNumber(?cup + 0e0, ?locale, "maximumFractionDigits=4")), STR(?cl)) AS ?data)
  }
  }
}""" .

# A legend item: a toggle button with the series' swatch and name, pressed while the series is shown. A click
# hides the series in its chart (c:hiddenSeries, its key; the plan mints no points for it) or shows it again.
c:ChartSeriesRendering a sem:Rendering ; sem:targets c:ChartSeries ; sem:modality mod:Screen ; sem:stratum 0 ; sem:follows c:inChart .
c:ChartSeriesRendering-fn a sem:Rule ; sem:implements c:ChartSeriesRendering ; sem:function "series:legend-item" .
c:ChartSeriesRendering-sparql a sem:Rule ; sem:implements c:ChartSeriesRendering ;
    sem:construct """
''' + HEAD + '''
WHERE {
  $this a c:ChartSeries ; c:inChart ?chart ; c:index ?i ; c:label ?label .
  BIND(STR($this) AS ?me)
  VALUES (?local ?tag0 ?parentLocal) { ("root" rdfhtml:Li UNDEF) ("toggle" rdfhtml:Button "root") ("swatch" rdfhtml:I "toggle") }
  BIND(IRI(CONCAT(?me, "/~", ?local)) AS ?el) BIND(?tag0 AS ?tag)
  BIND(IF(?local = "root", ?el, ?unset) AS ?shownRoot)
  BIND(IF(BOUND(?parentLocal), IRI(CONCAT(?me, "/~", ?parentLocal)), ?unset) AS ?parent)
  BIND(IF(?local = "swatch", 0, ?unset) AS ?key)
  BIND(IF(?local = "root" && EXISTS { $this c:secondary true }, "sem-secondary", ?unset) AS ?cls)
  BIND(IF(?local = "toggle", "button", ?unset) AS ?type)
  BIND(IF(?local = "swatch", CONCAT("background: var(--sem-series-", STR(xsd:integer(?i - FLOOR(?i / 6) * 6 + 1)), ")"), ?unset) AS ?style)
  BIND(IF(?local = "swatch", "aria-hidden", IF(?local = "toggle", "aria-pressed", ?unset)) AS ?an)
  BIND(IF(?local = "swatch", "true", IF(?local = "toggle", IF(EXISTS { $this c:seriesHidden true }, "false", "true"), ?unset)) AS ?av)
  BIND(IF(BOUND(?an), IRI(CONCAT(?me, "/~", ?local, "-", ?an)), ?unset) AS ?attr)
  BIND(IF(?local = "toggle", IRI(CONCAT(?me, "/~label")), ?unset) AS ?textNode)
  BIND(IF(?local = "toggle", STR(?label), ?unset) AS ?data) BIND(IF(?local = "toggle", 1, ?unset) AS ?textKey)
}""" .
c:SeriesToggle a beh:Reaction ;
    rdfs:label "Show or hide a series"@en ;
    beh:when beh:Click ;
    beh:sourceClass c:ChartSeries ;
    beh:deletes """CONSTRUCT { ?chart c:hiddenSeries ?h } WHERE { $this c:inChart ?chart ; c:key ?key . ?chart c:hiddenSeries ?h FILTER(STR(?h) = STR(?key)) }""" ;
    beh:inserts """CONSTRUCT { ?chart c:hiddenSeries ?k } WHERE { $this c:inChart ?chart ; c:key ?key . FILTER NOT EXISTS { ?chart c:hiddenSeries ?h FILTER(STR(?h) = STR(?key)) } BIND(STR(?key) AS ?k) }""" ;
    sem:function "series:toggle" .
''')

WORDS = '''  ?series c:label ?seriesLabel .
  OPTIONAL { $this c:base ?b0 } OPTIONAL { $this c:rank ?rank0 } OPTIONAL { $this c:nextValue ?nv } OPTIONAL { $this c:nextBase ?nb0 }
  OPTIONAL { $this c:x ?px } OPTIONAL { $this c:size ?pz } OPTIONAL { $this c:from ?pfrom ; c:share ?pshare }
  OPTIONAL { $this c:q1 ?pq1 ; c:q3 ?pq3 ; c:low ?plow ; c:high ?phigh }
  ?viewer l10n:formatLocale ?locale .
  OPTIONAL { ?unitAt l10n:of ?chart ; l10n:unit ?u0 }
  OPTIONAL { FILTER(!BOUND(?u0)) ?chart c:unit ?u1 FILTER(isLiteral(?u1)) } BIND(COALESCE(STR(?u0), STR(?u1), "") AS ?unit0)
  # A point of a series on the secondary axis says the secondary unit.
  OPTIONAL { ?unit2At l10n:of ?chart ; l10n:secondaryUnit ?su0 }
  OPTIONAL { FILTER(!BOUND(?su0)) ?chart c:secondaryUnit ?su1 FILTER(isLiteral(?su1)) }
  BIND(IF(EXISTS { $this c:secondary true }, COALESCE(STR(?su0), STR(?su1), ""), ?unit0) AS ?unit)
  # What it says: "category · series: value unit", the series when the chart has more than one.
  BIND(EXISTS { ?chart c:seriesVariable ?anySv } || EXISTS { ?chart c:legend ?anyLegend } AS ?many)
  BIND(STR(?cat0) AS ?cat) BIND(IF(?many, STR(?seriesLabel), "") AS ?ser)
  BIND(CONCAT(?cat, IF(?cat != "" && ?ser != "", " · ", ""), ?ser) AS ?head)
  ''' + MEASURES('?chart', '?v', '?px', '?pz') + '''
  BIND(IF(BOUND(?pshare), CONCAT(" (", sx:formatNumber(?pshare, ?locale, "style=percent;maximumFractionDigits=1"), ")"), "") AS ?percent)
  # A bin: its bounds with the chart's unit, then how many values fall in it.
  OPTIONAL { $this c:lower ?plo ; c:upper ?pup }
  BIND(IF(BOUND(?plo), CONCAT(sx:formatNumber(?plo + 0e0, ?locale, "maximumFractionDigits=4"), " – ", sx:formatNumber(?pup + 0e0, ?locale, "maximumFractionDigits=4"), IF(?unit = "", "", CONCAT(" ", ?unit))), ?unset) AS ?bounds)
  # A box: its median, quartiles and range.
  BIND(IRI(CONCAT(STR(?chart), "/~l10n-BoxMedianPhrase")) AS ?medianWordNode)
  OPTIONAL { ?medianWordNode l10n:label ?medianWord0 } OPTIONAL { c:BoxMedianPhrase rdfs:label ?medianWord1 FILTER(langMatches(lang(?medianWord1), "en")) }
  BIND(STR(COALESCE(?medianWord0, ?medianWord1)) AS ?medianWord)
  BIND(IRI(CONCAT(STR(?chart), "/~l10n-BoxQuartilesPhrase")) AS ?quartilesWordNode)
  OPTIONAL { ?quartilesWordNode l10n:label ?quartilesWord0 } OPTIONAL { c:BoxQuartilesPhrase rdfs:label ?quartilesWord1 FILTER(langMatches(lang(?quartilesWord1), "en")) }
  BIND(STR(COALESCE(?quartilesWord0, ?quartilesWord1)) AS ?quartilesWord)
  BIND(IRI(CONCAT(STR(?chart), "/~l10n-BoxRangePhrase")) AS ?rangeWordNode)
  OPTIONAL { ?rangeWordNode l10n:label ?rangeWord0 } OPTIONAL { c:BoxRangePhrase rdfs:label ?rangeWord1 FILTER(langMatches(lang(?rangeWord1), "en")) }
  BIND(STR(COALESCE(?rangeWord0, ?rangeWord1)) AS ?rangeWord)
  BIND(IF(BOUND(?pq1), CONCAT(?head, ": ", ?medianWord, " ", sx:formatNumber(?v, ?locale, "maximumFractionDigits=2"), IF(?unit = "", "", CONCAT(" ", ?unit)),
    "; ", ?quartilesWord, " ", sx:formatNumber(?pq1, ?locale, "maximumFractionDigits=2"), " – ", sx:formatNumber(?pq3, ?locale, "maximumFractionDigits=2"),
    "; ", ?rangeWord, " ", sx:formatNumber(?plow, ?locale, "maximumFractionDigits=2"), " – ", sx:formatNumber(?phigh, ?locale, "maximumFractionDigits=2")), ?unset) AS ?boxWords)
  BIND(IF(BOUND(?boxWords), ?boxWords, IF(BOUND(?bounds), CONCAT(?bounds, IF(?ser != "", " · ", ""), ?ser, ": ", sx:formatNumber(?v, ?locale, "maximumFractionDigits=2")), CONCAT(?head, ": ", ?measures, ?percent))) AS ?words)
'''

def point_rule(name, cls, rootClass, marks_values, marks_filter, colorBy='?si'):
    return f'''
c:{name}Rendering a sem:Rendering ; sem:targets c:{cls} ; sem:modality mod:Screen ; sem:stratum 0 ; sem:follows c:inChart .
c:{name}Rendering-sparql a sem:Rule ; sem:implements c:{name}Rendering ; sem:needsExtension sx:Locale ;
    sem:construct """
''' + HEAD + '''
WHERE {
  $this a c:''' + cls + ''' ; c:inChart ?chart ; c:value ?v ; c:seriesIndex ?si ; c:categoryIndex ?ci ; c:category ?cat0 ; c:series ?series .
''' + WORDS + '''
  BIND(CONCAT("--i: ", STR(?ci), "; --s: ", STR(?si), "; --r: ", STR(COALESCE(?rank0, 0)), "; --v: ", ''' + F('?v') + ''', "; --b: ", ''' + F('COALESCE(?b0, 0e0)') + ''',
    IF(BOUND(?nv), CONCAT("; --nv: ", ''' + F('?nv') + ''', "; --nb: ", ''' + F('COALESCE(?nb0, 0e0)') + '''), ""),
    IF(BOUND(?px), CONCAT("; --x: ", ''' + F('?px') + '''), ""), IF(BOUND(?pz), CONCAT("; --z: ", ''' + F('?pz') + '''), ""),
    IF(BOUND(?pq1), CONCAT("; --q1: ", ''' + F('?pq1') + ''', "; --q3: ", ''' + F('?pq3') + ''', "; --low: ", ''' + F('?plow') + ''', "; --high: ", ''' + F('?phigh') + '''), ""),
    IF(BOUND(?pshare), CONCAT("; --from: ", ''' + F('?pfrom') + ''', "; --share: ", ''' + F('?pshare') + '''), ""),
    "; --color: var(--sem-series-", STR(xsd:integer(''' + colorBy + ''' - FLOOR(''' + colorBy + ''' / 6) * 6 + 1)), ")") AS ?pointStyle)
  BIND(STR($this) AS ?me)
  VALUES (?local ?tag0 ?cls0 ?key0) { ("root" rdfhtml:Li UNDEF UNDEF) ''' + marks_values + ''' ("words" rdfhtml:Span "sem-visually-hidden" 9) }
  FILTER(''' + marks_filter + ''')
  BIND(IRI(CONCAT(?me, "/~", ?local)) AS ?el) BIND(?tag0 AS ?tag) BIND(?key0 AS ?key)
  BIND(IF(?local = "root", CONCAT("sem-point ", ''' + rootClass + ''', IF(EXISTS { $this c:secondary true }, " sem-secondary", "")), ?cls0) AS ?cls)
  BIND(IF(?local = "root", ?el, ?unset) AS ?shownRoot)
  BIND(IF(?local = "root", ?unset, IRI(CONCAT(?me, "/~root"))) AS ?parent)
  BIND(IF(?local = "root", ?pointStyle, ?unset) AS ?style)
  BIND(IF(?local = "root", ?words, ?unset) AS ?tip)
  BIND(IF(?local = "root", IF(EXISTS { $this c:first true }, "0", "-1"), ?unset) AS ?tabindex)
  BIND(IF(?local = "root" || ?local = "words", ?unset, IRI(CONCAT(?me, "/~", ?local, "-aria-hidden"))) AS ?attr)
  BIND(IF(BOUND(?attr), "aria-hidden", ?unset) AS ?an) BIND(IF(BOUND(?attr), "true", ?unset) AS ?av)
  BIND(IF(?local = "words", IRI(CONCAT(?me, "/~words-text")), ?unset) AS ?textNode)
  BIND(IF(?local = "words", ?words, ?unset) AS ?data)
}""" .
'''

out.append('''
# --- Area chart ----------------------------------------------------------------------------------------
# A point is a dot at its value; while its series goes on, the area under the line to the next point
# (a clip-path from its base to its value and the next's) and the line itself (a segment turned by
# atan2 in the plot's container units). Stacked (c:stacked true), each series' area starts where the
# earlier series end.
c:AreaChart a owl:Class ; rdfs:subClassOf c:AxisChart ;
    rdfs:label "Area chart"@en , "Діаграма з областями"@uk , "Flächendiagramm"@de , "مخطط مساحي"@ar ;
    rdfs:comment "Values of each series across the categories, as a line with the area under it; c:stacked stacks the series."@en ;
    c:pointClass c:AreaPoint ;
    sem:slug "area-chart" .
c:AreaPoint a owl:Class ; rdfs:subClassOf c:ChartPoint ;
    rdfs:comment "Internal: a point of an area chart: a dot, and the area and line to the next point of its series."@en ;
    sem:slug "area-point" .
c:AreaPointRendering-fn a sem:Rule ; sem:implements c:AreaPointRendering ; sem:function "series:area-point" .''')
out.append(point_rule('AreaPoint', 'AreaPoint', '"sem-area-point"',
    '("area" rdfhtml:Span "sem-area" 0) ("line" rdfhtml:Span "sem-segment" 1) ("dot" rdfhtml:Span "sem-dot" 2)',
    '!(?local IN ("area", "line")) || BOUND(?nv)'))

out.append('''
# --- Column chart ---------------------------------------------------------------------------------------
# A point is a bar from its base to its value: side by side with the other shown series' in its category
# (grouped, by its rank among them), or on the earlier series' (c:stacked true). Negative values hang below zero.
c:ColumnChart a owl:Class ; rdfs:subClassOf c:AxisChart ;
    rdfs:label "Column chart"@en , "Стовпчикова діаграма"@uk , "Säulendiagramm"@de , "مخطط أعمدة"@ar ;
    rdfs:comment "A bar per series and category, grouped side by side; c:stacked stacks the series in one bar per category."@en ;
    c:pointClass c:ColumnPoint ;
    sem:slug "column-chart" .
c:ColumnPoint a owl:Class ; rdfs:subClassOf c:ChartPoint ;
    rdfs:comment "Internal: a point of a column chart: a bar from its base to its value."@en ;
    sem:slug "column-point" .
c:rank a owl:DatatypeProperty ; rdfs:comment "Derived: how many shown series with points come before a point's series."@en .
c:ColumnPointRendering-fn a sem:Rule ; sem:implements c:ColumnPointRendering ; sem:function "series:column-point" .''')
out.append(point_rule('ColumnPoint', 'ColumnPoint', 'IF(EXISTS { ?chart c:stacked true }, "sem-column-point sem-stacked", "sem-column-point")',
    '("bar" rdfhtml:Span "sem-bar" 0)', 'true'))

out.append('''
# --- Scatter and bubble charts ---------------------------------------------------------------------------
# A point per series and category (a row's label), at its x (c:xVariable) and value, on scales that need not
# include zero (c:fromZero false); with c:sizeVariable its dot's area grows with its size (a bubble chart).
# Below the plot are the x scale's ticks; a point says its x and size, named by c:xLabel and c:sizeLabel.
c:ScatterChart a owl:Class ; rdfs:subClassOf c:AxisChart ;
    rdfs:label "Scatter chart"@en , "Точкова діаграма"@uk , "Streudiagramm"@de , "مخطط مبعثر"@ar ;
    rdfs:comment "Points at their x (c:xVariable) and value, a color per series; with c:sizeVariable, bubbles as large as their size."@en ;
    c:pointClass c:ScatterPoint ; c:fromZero false ;
    sem:slug "scatter-chart" .
c:ScatterPoint a owl:Class ; rdfs:subClassOf c:ChartPoint ;
    rdfs:comment "Internal: a point of a scatter chart: a dot at its x and value, sized by its size."@en ;
    sem:slug "scatter-point" .
c:xVariable a owl:DatatypeProperty ; rdfs:comment "SELECT variable for a point's x, a number (a scatter chart's horizontal axis)."@en .
c:sizeVariable a owl:DatatypeProperty ; rdfs:comment "SELECT variable for a point's size (a bubble's area)."@en .
c:xLabel a owl:DatatypeProperty ; rdfs:comment "What a point's x is called in words (default: the x variable's name)."@en .
c:sizeLabel a owl:DatatypeProperty ; rdfs:comment "What a point's size is called in words (default: the size variable's name)."@en .
c:fromZero a owl:DatatypeProperty ; rdfs:domain owl:Class ; rdfs:range xsd:boolean ; rdfs:comment "On a chart kind: false when its scales need not include zero."@en .
c:x a owl:DatatypeProperty ; rdfs:comment "Derived: a point's x."@en .
c:size a owl:DatatypeProperty ; rdfs:comment "Derived: a point's size."@en .
c:xScale a owl:ObjectProperty ; rdfs:range c:ValueScale ; rdfs:comment "Derived: a chart's x scale."@en .
c:sizeMax a owl:DatatypeProperty ; rdfs:comment "Derived: the greatest size of a chart's points."@en .
c:ScatterPointRendering-fn a sem:Rule ; sem:implements c:ScatterPointRendering ; sem:function "series:scatter-point" .''')
out.append(point_rule('ScatterPoint', 'ScatterPoint', '"sem-scatter-point"', '("dot" rdfhtml:Span "sem-dot" 0)', 'true'))

out.append('''
# --- Pie and donut charts ----------------------------------------------------------------------------------
# A polar kind (c:polar true): c:SeriesLayout gives each point its share of the positive total (c:share) and
# where it starts (c:from, the shares of the points before it), and the chart its total. A slice is a conic
# wedge in its category's color (clipped to the wedge, so hovering finds it); the frame is the pie and a key
# of the categories. A donut (c:hole true) shows the total in its hole. Slices run clockwise from the top,
# counter-clockwise right to left. A slice says its share.
c:PieChart a owl:Class ; rdfs:subClassOf c:SeriesChart ;
    rdfs:label "Pie chart"@en , "Кругова діаграма"@uk , "Kreisdiagramm"@de , "مخطط دائري"@ar ;
    rdfs:comment "Each category's share of the whole, as a slice in its color, with a key of the categories."@en ;
    c:pointClass c:SlicePoint ; c:polar true ;
    sem:slug "pie-chart" .
c:DonutChart a owl:Class ; rdfs:subClassOf c:PieChart ;
    rdfs:label "Donut chart"@en , "Кільцева діаграма"@uk , "Ringdiagramm"@de , "مخطط حلقي"@ar ;
    rdfs:comment "A pie with a hole, the total in it."@en ;
    c:pointClass c:SlicePoint ; c:hole true ;
    sem:slug "donut-chart" .
c:SlicePoint a owl:Class ; rdfs:subClassOf c:ChartPoint ;
    rdfs:comment "Internal: a slice of a pie: a wedge from c:from, c:share of the whole."@en ;
    sem:slug "slice-point" .
c:polar a owl:DatatypeProperty ; rdfs:domain owl:Class ; rdfs:range xsd:boolean ; rdfs:comment "On a chart kind: its points are shares of a whole (c:from, c:share, the chart's c:total)."@en .
c:hole a owl:DatatypeProperty ; rdfs:domain owl:Class ; rdfs:range xsd:boolean ; rdfs:comment "On a polar kind: it has a hole, with the total in it."@en .
c:from a owl:DatatypeProperty ; rdfs:comment "Derived: where a point's share starts, a fraction of the whole."@en .
c:share a owl:DatatypeProperty ; rdfs:comment "Derived: a point's share of the whole, a fraction."@en .
c:total a owl:DatatypeProperty ; rdfs:comment "Derived: the sum of a polar chart's positive values."@en .
c:SlicePointRendering-fn a sem:Rule ; sem:implements c:SlicePointRendering ; sem:function "series:slice-point" .''')
out.append(point_rule('SlicePoint', 'SlicePoint', '"sem-slice-point"', '("slice" rdfhtml:Span "sem-slice" 0)', 'true', '?ci'))
out.append('''
c:PieChartRendering a sem:Rendering ; sem:targets c:PieChart ; sem:modality mod:Screen ; sem:stratum 0 ; sem:follows c:dataset , c:view ; sem:readsMinted true .
c:PieChartRendering-fn a sem:Rule ; sem:implements c:PieChartRendering ; sem:function "series:pie-frame" .
c:PieChartRendering-sparql a sem:Rule ; sem:implements c:PieChartRendering ; sem:needsExtension sx:Locale ; sem:bulk false ;
    sem:construct """
''' + HEAD + '''
WHERE {
  $this a/rdfs:subClassOf* c:PieChart .
  BIND(STR($this) AS ?me)
  BIND(IRI(CONCAT(?me, "/~root")) AS ?root)
  ''' + MESSAGE + '''
  LATERAL {
  {
    FILTER(BOUND(?message))
    BIND(?root AS ?el) BIND(?root AS ?shownRoot) BIND(rdfhtml:P AS ?tag) BIND("sem-empty" AS ?cls)
    BIND(IRI(CONCAT(?me, "/~empty")) AS ?textNode) BIND(?message AS ?data)
  } UNION {
    # The figure: the pie (its slices, a donut's total), and the key.
    FILTER(!BOUND(?message))
    ''' + LABEL('$this', 'label') + '''
    OPTIONAL { $this c:total ?total }
    BIND(EXISTS { $this (a|a/rdfs:subClassOf+) ?holeKind . ?holeKind c:hole true } AS ?hole)
    VALUES (?local ?tag0 ?cls0 ?parentLocal ?key0) {
      ("root" rdfhtml:Figure UNDEF UNDEF UNDEF) ("pie" rdfhtml:Div "sem-pie" "root" 0) ("marks" rdfhtml:Ol "sem-chart-marks" "pie" 0)
      ("total" rdfhtml:Span "sem-pie-total" "pie" 1) ("keys" rdfhtml:Ul "sem-legend" "root" 1) }
    FILTER(?local != "total" || (?hole && BOUND(?total)))
    BIND(IRI(CONCAT(?me, "/~", ?local)) AS ?el) BIND(?tag0 AS ?tag) BIND(?cls0 AS ?cls) BIND(?key0 AS ?key)
    BIND(IF(?local = "root", ?root, ?unset) AS ?shownRoot)
    BIND(IF(BOUND(?parentLocal), IRI(CONCAT(?me, "/~", ?parentLocal)), ?unset) AS ?parent)
    LATERAL { OPTIONAL {
      VALUES (?forLocal ?an ?av0) { ("marks" "aria-label" UNDEF) ("total" "aria-hidden" "true") }
      FILTER(?forLocal = ?local)
      BIND(IRI(CONCAT(?me, "/~", ?local, "-", ?an)) AS ?attr) BIND(COALESCE(?av0, ?label) AS ?av)
    } }
    LATERAL { OPTIONAL {
      FILTER(?local = "total")
      ?viewer l10n:formatLocale ?locale .
      OPTIONAL { ?unitAt l10n:of $this ; l10n:unit ?u0 }
      OPTIONAL { FILTER(!BOUND(?u0)) $this c:unit ?u1 FILTER(isLiteral(?u1)) } BIND(COALESCE(STR(?u0), STR(?u1), "") AS ?unit)
      BIND(IRI(CONCAT(?me, "/~total-text")) AS ?textNode)
      BIND(CONCAT(sx:formatNumber(?total, ?locale, "maximumFractionDigits=2"), IF(?unit = "", "", CONCAT(" ", ?unit))) AS ?data)
    } }
  } UNION {
    # A key per category: its swatch and its name.
    FILTER(!BOUND(?message))
    ?cn a c:ChartCategory ; c:inChart $this ; c:index ?i ; c:label ?cl .
    BIND(CONCAT(?me, "/~key-", STR(?i)) AS ?keyId)
    VALUES ?part { "item" "swatch" }
    BIND(IRI(IF(?part = "item", ?keyId, CONCAT(?keyId, "-swatch"))) AS ?el)
    BIND(IF(?part = "item", rdfhtml:Li, rdfhtml:I) AS ?tag)
    BIND(IF(?part = "item", IRI(CONCAT(?me, "/~keys")), IRI(?keyId)) AS ?parent)
    BIND(IF(?part = "item", ?i, 0) AS ?key)
    BIND(IF(?part = "swatch", CONCAT("background: var(--sem-series-", STR(xsd:integer(?i - FLOOR(?i / 6) * 6 + 1)), ")"), ?unset) AS ?style)
    BIND(IF(?part = "swatch", IRI(CONCAT(?keyId, "-swatch-aria-hidden")), ?unset) AS ?attr)
    BIND(IF(?part = "swatch", "aria-hidden", ?unset) AS ?an) BIND(IF(?part = "swatch", "true", ?unset) AS ?av)
    BIND(IF(?part = "item", IRI(CONCAT(?keyId, "-text")), ?unset) AS ?textNode)
    BIND(IF(?part = "item", STR(?cl), ?unset) AS ?data) BIND(IF(?part = "item", 1, ?unset) AS ?textKey)
  }
  }
}""" .''')

BINS = '''{ SELECT ?start ?step ?count WHERE {
      { SELECT (MIN(?bx) AS ?lo) (MAX(?bx) AS ?hi) WHERE {
        ''' + ROWS + '''
        BIND(xsd:double(?v0) AS ?bx) FILTER(BOUND(?bx))
      } }
      FILTER(BOUND(?lo))
      OPTIONAL { $this c:binCount ?bc0 } BIND(COALESCE(xsd:integer(FLOOR(xsd:double(?bc0))), 10) AS ?asked)
      BIND(IF(?asked < 1, 1, IF(?asked > 50, 50, ?asked)) AS ?bins)
      BIND(IF(?hi - ?lo > 0, ?hi - ?lo, 1e0) / ?bins AS ?raw)
      BIND(sx:pow(10, FLOOR(sx:log10(?raw))) AS ?mag) BIND(?raw / ?mag AS ?ratio)
      BIND(IF(?ratio <= 1, 1, IF(?ratio <= 2, 2, IF(?ratio <= 5, 5, 10))) * ?mag AS ?step)
      BIND(FLOOR(?lo / ?step) * ?step AS ?start)
      BIND(xsd:integer(FLOOR((?hi - ?start) / ?step)) + 1 AS ?count)
    } }'''
out.append('''
# --- Histogram ---------------------------------------------------------------------------------------------
# A binned kind (c:binned true) has a plan of its own: its values (c:valueVariable, one per row) fall in bins
# of a nice step (1, 2 or 5 × 10ⁿ) for about c:binCount of them (default 10, at most 50), from a step below
# the least value to past the greatest. Each bin is a category (c:lower, c:upper, named by its bounds in the
# viewer's locale) and a point per shown series counts its rows' values in it, drawn as a column; the bars
# touch. A bin says its bounds and its count.
c:Histogram a owl:Class ; rdfs:subClassOf c:AxisChart ;
    rdfs:label "Histogram"@en , "Гістограма"@uk , "Histogramm"@de , "مدرج تكراري"@ar ;
    rdfs:comment "How a view's values are distributed: a column per bin of nice bounds, as tall as its count; c:binCount bins, about (default 10)."@en ;
    c:pointClass c:ColumnPoint ; c:binned true ; c:ownPlan true ;
    sem:slug "histogram" .
c:ownPlan a owl:DatatypeProperty ; rdfs:domain owl:Class ; rdfs:range xsd:boolean ; rdfs:comment "On a chart kind: it mints its series, categories and points with a plan of its own; c:SeriesPlan leaves it alone."@en .
c:binned a owl:DatatypeProperty ; rdfs:domain owl:Class ; rdfs:range xsd:boolean ; rdfs:comment "On a chart kind: its categories are bins of its values (c:HistogramPlan)."@en .
c:binCount a owl:DatatypeProperty ; rdfs:comment "About how many bins a histogram has (default 10, at most 50)."@en .
c:lower a owl:DatatypeProperty ; rdfs:comment "Derived: a bin's least value."@en .
c:upper a owl:DatatypeProperty ; rdfs:comment "Derived: a bin's bound (its values are below it)."@en .

c:HistogramPlan a sem:Rendering ; sem:targets c:Histogram ; sem:stratum -2 ; sem:inputOnly true ;
    sem:follows c:dataset , c:hiddenSeries , ( c:view rs:solution rs:binding ) , ( c:legend [ sem:zeroOrMore rdf:rest ] rdf:first ) .
c:HistogramPlan-fn a sem:Rule ; sem:implements c:HistogramPlan ; sem:function "series:histogram-plan" .
c:HistogramPlan-sparql a sem:Rule ; sem:implements c:HistogramPlan ; sem:needsExtension sx:Math ; sem:bulk false ;
    sem:construct """
CONSTRUCT {
  ?node a ?type , ?type2 ; c:inChart $this ; c:key ?key ; c:label ?label ; c:index ?index ; c:seriesHidden ?hidden ; c:secondary ?secondary ; sem:orderKey ?okey ;
    c:series ?seriesNode ; c:category ?category ; c:value ?value ; c:seriesIndex ?seriesIndex ; c:categoryIndex ?categoryIndex ; c:lower ?lower ; c:upper ?upper .
  ?container rdfhtml:hasChild ?node .
}
WHERE {
  $this a/rdfs:subClassOf* c:Histogram ; c:view ?theView .
  ?theView a rs:ResultSet .
  BIND(STR($this) AS ?me)
  LATERAL {
  {
    # Its series, as a series chart's (when it has values).
    ''' + BINS + '''
''' + SERIES + '''    BIND(IRI(CONCAT(?me, "/~series-", SUBSTR(MD5(?skey), 1, 8))) AS ?node)
    BIND(c:ChartSeries AS ?type) BIND(?skey AS ?key) BIND(?slabel AS ?label) BIND(?si AS ?index)
    BIND(IF(EXISTS { $this c:hiddenSeries ?h FILTER(STR(?h) = ?skey) }, true, ?unset) AS ?hidden)
    BIND(IF(EXISTS { $this (c:legend/rdf:first|c:legend/rdf:rest+/rdf:first) ?axisSeries . ?axisSeries c:axis c:SecondaryAxis . OPTIONAL { ?axisSeries c:key ?axisKey } FILTER(COALESCE(STR(?axisKey), STR(?axisSeries)) = ?skey) }, true, ?unset) AS ?secondary)
    BIND(CONCAT("\\\\u0001n", STR(?si)) AS ?okey)
    BIND(IRI(CONCAT(?me, "/~legend")) AS ?container)
  } UNION {
    # A category per bin.
    ''' + BINS + '''
    VALUES ?k { ''' + ' '.join(str(i) for i in range(51)) + ''' }
    FILTER(?k < ?count)
    BIND(IRI(CONCAT(?me, "/~category-", SUBSTR(MD5(STR(?k)), 1, 8))) AS ?node)
    BIND(c:ChartCategory AS ?type) BIND(?k AS ?index)
    BIND(?start + ?k * ?step AS ?lower) BIND(?start + (?k + 1) * ?step AS ?upper)
    BIND(CONCAT(''' + F('?lower') + ''', "–", ''' + F('?upper') + ''') AS ?label)
  } UNION {
    # A point per shown series and bin with values: how many.
    { SELECT ?ser ?k (SUM(?mult) AS ?n) WHERE {
      ''' + BINS + '''
      ''' + ROWS + '''
      BIND(xsd:double(?v0) AS ?x) FILTER(BOUND(?x) && BOUND(?ser))
      BIND(xsd:integer(FLOOR((?x - ?start) / ?step)) AS ?k)
    } GROUP BY ?ser ?k }
    ''' + BINS + '''
''' + SERIES + '''    FILTER(?skey = ?ser)
    FILTER NOT EXISTS { $this c:hiddenSeries ?h FILTER(STR(?h) = ?skey) }
    BIND(IRI(CONCAT(?me, "/~point-", SUBSTR(MD5(?ser), 1, 8), "-", SUBSTR(MD5(STR(?k)), 1, 8))) AS ?node)
    BIND(c:ChartPoint AS ?type)
    OPTIONAL { $this a ?kind . ?kind c:pointClass ?type2 }
    BIND(IRI(CONCAT(?me, "/~series-", SUBSTR(MD5(?ser), 1, 8))) AS ?seriesNode)
    BIND(?start + ?k * ?step AS ?lower) BIND(?start + (?k + 1) * ?step AS ?upper)
    BIND(CONCAT(''' + F('?lower') + ''', "–", ''' + F('?upper') + ''') AS ?category)
    BIND(?n AS ?value) BIND(?si AS ?seriesIndex) BIND(?k AS ?categoryIndex)
    BIND(CONCAT("\\\\u0001n", STR(?si), "\\\\u0001n", STR(?k)) AS ?okey)
    BIND(IRI(CONCAT(?me, "/~marks")) AS ?container)
  }
  }
}""" .''')

out.append('''
# --- Series charts as text ------------------------------------------------------------------------------------
# A series chart's Text modality: its name, then its points, each a line of the words it says on screen.
c:SeriesChartText a sem:Rendering ; sem:targets c:SeriesChart ; sem:modality mod:Text ; sem:stratum 0 ; sem:readsMinted true ;
    sem:follows c:dataset , c:view , c:annotation , ( c:annotation c:at ) , ( c:annotation c:fromValue ) , ( c:annotation c:toValue ) , ( c:annotation rdfs:label ) .
c:SeriesChartText-fn a sem:Rule ; sem:implements c:SeriesChartText ; sem:function "series:text" .
c:SeriesChartText-sparql a sem:Rule ; sem:implements c:SeriesChartText ; sem:needsExtension sx:Locale ; sem:bulk false ;
    sem:construct """
''' + HEAD + '''
WHERE {
  $this a/rdfs:subClassOf* c:SeriesChart .
  BIND(STR($this) AS ?me)
  BIND(IRI(CONCAT(?me, "/~root")) AS ?root)
  ''' + MESSAGE + '''
  LATERAL {
  {
    FILTER(BOUND(?message))
    BIND(?root AS ?el) BIND(?root AS ?shownRoot) BIND(rdfhtml:P AS ?tag) BIND("sem-empty" AS ?cls)
    BIND(IRI(CONCAT(?me, "/~empty")) AS ?textNode) BIND(?message AS ?data)
  } UNION {
    FILTER(!BOUND(?message))
    ''' + LABEL('$this', 'label') + '''
    VALUES (?local ?tag0 ?key0) { ("root" rdfhtml:Div UNDEF) ("title" rdfhtml:P "\\\\u0001n0") ("marks" rdfhtml:Div "\\\\u0001n1") }
    BIND(IRI(CONCAT(?me, "/~", ?local)) AS ?el) BIND(?tag0 AS ?tag) BIND(?key0 AS ?key)
    BIND(IF(?local = "root", ?root, ?unset) AS ?shownRoot)
    BIND(IF(?local = "root", ?unset, ?root) AS ?parent)
    BIND(IF(?local = "title", IRI(CONCAT(?me, "/~title-text")), ?unset) AS ?textNode)
    BIND(IF(?local = "title", ?label, ?unset) AS ?data)
  } UNION {
    # Its annotations, a line each, after its points.
    FILTER(!BOUND(?message))
    ''' + ANN + '''
    BIND(IRI(?annId) AS ?el) BIND(rdfhtml:P AS ?tag) BIND(?root AS ?parent) BIND(CONCAT("\\\\u0001n2", ?annKey) AS ?key)
    BIND(IRI(CONCAT(?annId, "-text")) AS ?textNode) BIND(?annWords AS ?data)
  }
  }
}""" .
c:ChartPointText a sem:Rendering ; sem:targets c:ChartPoint ; sem:modality mod:Text ; sem:stratum 0 ; sem:follows c:inChart .
c:ChartPointText-fn a sem:Rule ; sem:implements c:ChartPointText ; sem:function "series:point-text" .
c:ChartPointText-sparql a sem:Rule ; sem:implements c:ChartPointText ; sem:needsExtension sx:Locale ;
    sem:construct """
''' + HEAD + '''
WHERE {
  $this a c:ChartPoint ; c:inChart ?chart ; c:value ?v ; c:seriesIndex ?si ; c:categoryIndex ?ci ; c:category ?cat0 ; c:series ?series .
''' + WORDS + '''
  BIND(IRI(CONCAT(STR($this), "/~root")) AS ?el) BIND(?el AS ?shownRoot) BIND(rdfhtml:P AS ?tag)
  BIND(IRI(CONCAT(STR($this), "/~words-text")) AS ?textNode) BIND(?words AS ?data)
}""" .''')

out.append('''
# --- Sparkline ---------------------------------------------------------------------------------------------
# A word-sized area chart: a series' line and the area under it, on a scale of its own values (c:fromZero
# false), with no axes or legend, its last point marked. It goes where text goes: in a tile beside a figure,
# or in a table's cell (a c:Column with c:format "component" whose value names it). Its points are list items
# with their words, as any series chart's.
c:Sparkline a owl:Class ; rdfs:subClassOf c:SeriesChart ;
    rdfs:label "Sparkline"@en , "Спарклайн"@uk , "Sparkline"@de , "خط بياني مصغّر"@ar ;
    rdfs:comment "A word-sized line of a view's values with the area under it, no axes; for tiles and table cells."@en ;
    c:pointClass c:AreaPoint ; c:fromZero false ;
    sem:slug "sparkline" .
c:SparklineRendering a sem:Rendering ; sem:targets c:Sparkline ; sem:modality mod:Screen ; sem:stratum 0 ; sem:follows c:dataset , c:view ; sem:readsMinted true .
c:SparklineRendering-fn a sem:Rule ; sem:implements c:SparklineRendering ; sem:function "series:sparkline-frame" .
c:SparklineRendering-sparql a sem:Rule ; sem:implements c:SparklineRendering ; sem:needsExtension sx:Locale ; sem:bulk false ;
    sem:construct \"\"\"
''' + HEAD + '''
WHERE {
  $this a/rdfs:subClassOf* c:Sparkline .
  BIND(STR($this) AS ?me)
  BIND(IRI(CONCAT(?me, "/~root")) AS ?root)
  ''' + MESSAGE + '''
  LATERAL {
  {
    FILTER(BOUND(?message))
    BIND(?root AS ?el) BIND(?root AS ?shownRoot) BIND(rdfhtml:P AS ?tag) BIND("sem-empty" AS ?cls)
    BIND(IRI(CONCAT(?me, "/~empty")) AS ?textNode) BIND(?message AS ?data)
  } UNION {
    FILTER(!BOUND(?message))
    ''' + LABEL('$this', 'label') + '''
    OPTIONAL { $this c:valueScale ?scale . ?scale a c:ValueScale ; c:min ?min ; c:max ?max }
    { SELECT (COUNT(?cn) AS ?n) WHERE { ?cn a c:ChartCategory ; c:inChart $this } }
    VALUES ?local { "root" "marks" }
    BIND(IRI(CONCAT(?me, "/~", ?local)) AS ?el)
    BIND(IF(?local = "root", rdfhtml:Span, rdfhtml:Ol) AS ?tag)
    BIND(IF(?local = "root", ?root, ?unset) AS ?shownRoot)
    BIND(IF(?local = "root", ?unset, ?root) AS ?parent)
    BIND(IF(?local = "root", ?unset, 0) AS ?key)
    BIND(IF(?local = "marks", "sem-chart-marks", ?unset) AS ?cls)
    BIND(IF(?local = "root", CONCAT(IF(BOUND(?min), CONCAT("--lo: ", ''' + F('?min') + ''', "; --hi: ", ''' + F('?max') + ''', "; "), ""), "--n: ", STR(?n), "; --k: 1"), ?unset) AS ?style)
    BIND(IF(?local = "marks", IRI(CONCAT(?me, "/~marks-aria-label")), ?unset) AS ?attr)
    BIND(IF(?local = "marks", "aria-label", ?unset) AS ?an) BIND(IF(?local = "marks", ?label, ?unset) AS ?av)
  }
  }
}\"\"\" .''')

A_ROWS = '''{ SELECT ?ser ?cat ?x (SUM(?mult) AS ?m) WHERE {
        ''' + ROWS + '''
        BIND(xsd:double(?v0) AS ?x) FILTER(BOUND(?x) && BOUND(?ser))
      } GROUP BY ?ser ?cat ?x }'''
import re as _re
def _ren(t, names, suf):
    for n in names: t = _re.sub(r'\?' + n + r'\b', '?' + n + suf, t)
    return t
CUM = '''{ SELECT ?ser ?cat ?x ?m (SUM(COALESCE(?m2, 0)) AS ?lt) WHERE {
      ''' + A_ROWS + '''
      OPTIONAL { { SELECT (?ser AS ?ser2) (?cat AS ?cat2) (?x AS ?x2) (?m AS ?m2) WHERE { ''' + A_ROWS + ''' } } FILTER(?ser2 = ?ser && ?cat2 = ?cat && ?x2 < ?x) }
    } GROUP BY ?ser ?cat ?x ?m }'''
def AT(suf):
    return '''{ SELECT ?ser ?cat (?x AS ?x''' + suf + ''') (?m AS ?m''' + suf + ''') (?lt AS ?lt''' + suf + ''') WHERE { ''' + CUM + ''' } }'''
BOXES = '''{ SELECT ?ser ?cat (SUM(IF(?p = 0.25, ?q, 0e0)) AS ?q1v) (SUM(IF(?p = 0.5, ?q, 0e0)) AS ?medv) (SUM(IF(?p = 0.75, ?q, 0e0)) AS ?q3v) WHERE {
      { SELECT ?ser ?cat (SUM(?m) AS ?n) WHERE { ''' + A_ROWS + ''' } GROUP BY ?ser ?cat }
      VALUES ?p { 0.25 0.5 0.75 }
      BIND((?n - 1) * ?p AS ?h) BIND(FLOOR(?h) AS ?i) BIND(IF(?i + 1 < ?n - 1, ?i + 1, ?n - 1) AS ?j)
      ''' + AT('i') + ''' FILTER(?lti <= ?i && ?i < ?lti + ?mi)
      ''' + AT('j') + ''' FILTER(?ltj <= ?j && ?j < ?ltj + ?mj)
      BIND(?xi + (?h - ?i) * (?xj - ?xi) AS ?q)
    } GROUP BY ?ser ?cat }
    { SELECT ?ser ?cat (MIN(?x) AS ?lowv) (MAX(?x) AS ?highv) WHERE { ''' + A_ROWS + ''' } GROUP BY ?ser ?cat }'''
out.append('''
# --- Box plot -------------------------------------------------------------------------------------------------
# A kind with a plan of its own (c:BoxPlan): a box per shown series and category of a view's values, with
# its median (c:value), quartiles (c:q1, c:q3, by linear interpolation between the closest ranks) and its
# least and greatest value (c:low, c:high); the scale includes the whiskers. A box is a whisker over its
# range, a box over its quartiles and a line at its median, side by side with the other series' (by rank).
# It says its median, quartiles and range, named by the chart's phrases.
c:BoxPlot a owl:Class ; rdfs:subClassOf c:AxisChart ;
    rdfs:label "Box plot"@en , "Коробкова діаграма"@uk , "Boxplot"@de , "مخطط صندوقي"@ar ;
    rdfs:comment "How each category's values spread: a box from the first to the third quartile, a line at the median, whiskers to the least and greatest value; a box per series."@en ;
    c:pointClass c:BoxPoint ; c:ownPlan true ; c:fromZero false ;
    l10n:phrase c:BoxMedianPhrase , c:BoxQuartilesPhrase , c:BoxRangePhrase ;
    sem:slug "box-plot" .
c:BoxPoint a owl:Class ; rdfs:subClassOf c:ChartPoint ;
    rdfs:comment "Internal: a box of a box plot: whisker, box and median."@en ;
    sem:slug "box-point" .
c:q1 a owl:DatatypeProperty ; rdfs:comment "Derived: a box's first quartile."@en .
c:q3 a owl:DatatypeProperty ; rdfs:comment "Derived: a box's third quartile."@en .
c:low a owl:DatatypeProperty ; rdfs:comment "Derived: a box's least value."@en .
c:high a owl:DatatypeProperty ; rdfs:comment "Derived: a box's greatest value."@en .
c:BoxMedianPhrase a c:Phrase ; rdfs:label "median"@en , "медіана"@uk , "Median"@de , "الوسيط"@ar .
c:BoxQuartilesPhrase a c:Phrase ; rdfs:label "quartiles"@en , "квартилі"@uk , "Quartile"@de , "الربيعات"@ar .
c:BoxRangePhrase a c:Phrase ; rdfs:label "range"@en , "діапазон"@uk , "Spanne"@de , "المدى"@ar .

c:BoxPlan a sem:Rendering ; sem:targets c:BoxPlot ; sem:stratum -2 ; sem:inputOnly true ;
    sem:follows c:dataset , c:hiddenSeries , ( c:view rs:solution rs:binding ) , ( c:legend [ sem:zeroOrMore rdf:rest ] rdf:first ) .
c:BoxPlan-fn a sem:Rule ; sem:implements c:BoxPlan ; sem:function "series:box-plan" .
c:BoxPlan-sparql a sem:Rule ; sem:implements c:BoxPlan ; sem:bulk false ;
    sem:construct \"\"\"
CONSTRUCT {
  ?node a ?type , ?type2 ; c:inChart $this ; c:key ?key ; c:label ?label ; c:index ?index ; c:seriesHidden ?hidden ; c:secondary ?secondary ; sem:orderKey ?okey ;
    c:series ?seriesNode ; c:category ?category ; c:value ?value ; c:q1 ?q1 ; c:q3 ?q3 ; c:low ?low ; c:high ?high ; c:seriesIndex ?seriesIndex ; c:categoryIndex ?categoryIndex .
  ?container rdfhtml:hasChild ?node .
}
WHERE {
  $this a/rdfs:subClassOf* c:BoxPlot ; c:view ?theView .
  ?theView a rs:ResultSet .
  BIND(STR($this) AS ?me)
  LATERAL {
  {
''' + SERIES + '''    BIND(IRI(CONCAT(?me, "/~series-", SUBSTR(MD5(?skey), 1, 8))) AS ?node)
    BIND(c:ChartSeries AS ?type) BIND(?skey AS ?key) BIND(?slabel AS ?label) BIND(?si AS ?index)
    BIND(IF(EXISTS { $this c:hiddenSeries ?h FILTER(STR(?h) = ?skey) }, true, ?unset) AS ?hidden)
    BIND(IF(EXISTS { $this (c:legend/rdf:first|c:legend/rdf:rest+/rdf:first) ?axisSeries . ?axisSeries c:axis c:SecondaryAxis . OPTIONAL { ?axisSeries c:key ?axisKey } FILTER(COALESCE(STR(?axisKey), STR(?axisSeries)) = ?skey) }, true, ?unset) AS ?secondary)
    BIND(CONCAT("\\\\u0001n", STR(?si)) AS ?okey)
    BIND(IRI(CONCAT(?me, "/~legend")) AS ?container)
  } UNION {
    ''' + CATEGORIES + '''
    BIND(IRI(CONCAT(?me, "/~category-", SUBSTR(MD5(?cat), 1, 8))) AS ?node)
    BIND(c:ChartCategory AS ?type) BIND(?ci AS ?index) BIND(?cat AS ?label)
  } UNION {
    # A box per shown series and category with values.
    ''' + BOXES + '''
''' + SERIES + '''    FILTER(?skey = ?ser)
    FILTER NOT EXISTS { $this c:hiddenSeries ?h FILTER(STR(?h) = ?skey) }
    ''' + CATEGORIES + '''
    BIND(IRI(CONCAT(?me, "/~point-", SUBSTR(MD5(?ser), 1, 8), "-", SUBSTR(MD5(?cat), 1, 8))) AS ?node)
    BIND(c:ChartPoint AS ?type)
    OPTIONAL { $this a ?kind . ?kind c:pointClass ?type2 }
    BIND(IRI(CONCAT(?me, "/~series-", SUBSTR(MD5(?ser), 1, 8))) AS ?seriesNode)
    BIND(?cat AS ?category) BIND(?medv AS ?value) BIND(?q1v AS ?q1) BIND(?q3v AS ?q3) BIND(?lowv AS ?low) BIND(?highv AS ?high)
    BIND(?si AS ?seriesIndex) BIND(?ci AS ?categoryIndex)
    BIND(CONCAT("\\\\u0001n", STR(?si), "\\\\u0001n", STR(?ci)) AS ?okey)
    BIND(IRI(CONCAT(?me, "/~marks")) AS ?container)
  }
  }
}\"\"\" .
c:BoxPointRendering-fn a sem:Rule ; sem:implements c:BoxPointRendering ; sem:function "series:box-point" .''')
out.append(point_rule('BoxPoint', 'BoxPoint', '"sem-box-point"', '("whisker" rdfhtml:Span "sem-whisker" 0) ("box" rdfhtml:Span "sem-box" 1) ("median" rdfhtml:Span "sem-median" 2)', 'true'))

_block = '\n'.join(out)
_a = _ttl.index('# --- Series charts: shared parts')
_b = _ttl.index('# --- Gantt ------')
open(TTL, 'w').write(_ttl[:_a] + _block + '\n' + _ttl[_b:])
