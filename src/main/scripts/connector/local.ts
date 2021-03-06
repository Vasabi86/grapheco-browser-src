/**
 * Created by bluejoe on 2018/2/24.
 */
import { Connector } from './connector';
import { Utils } from '../utils';
import { } from "jquery";
import { NodeNEdges, Pair, Gson, ShowGraphOptions, QueryResults, RelationPath } from '../types';
import * as vis from "vis";

export class LocalGraph implements Connector {
    private _nodes: object[];
    private _edges: object[];
    private _labels: object;
    private _callbackLoadData: (callbackAfterLoad: () => void) => void;

    //indices
    private _indexDB = {
        _mapId2Node: new Map<string, object>(),
        _mapId2Edge: new Map<string, object>(),
        _mapNodeId2NeighbourNodeIds: new Map<string, Set<string>>(),
        _mapNodePair2EdgeIds: new Map<string, Set<string>>(),
    };

    //TODO: defines translators() in gson
    private _defaultTranslateGson2GraphData: (source: Gson) => NodeNEdges = function (source: Gson) {
        var nodes = source.data.nodes;
        var edges = source.data.edges;
        var counterNode = 1;
        var counterEdge = 1;

        nodes.forEach((node: any) => {
            //set description
            if (node.description === undefined) {
                var description = "<p align=center>";
                if (node.image !== undefined) {
                    description += "<img src='" + node.image + "' width=150/><br>";
                }
                description += "<b>" + node.label + "</b>" + "[" + node.id + "]";
                description += "</p>";

                if (node.info !== undefined) {
                    description += "<p align=left>" + node.info + "</p>";
                }
                else {
                    if (node.title !== undefined)
                        description += "<p align=left>" + node.title + "</p>";
                }

                node.description = description;
            }

            if (node.id === undefined)
                node.id = counterNode++;

            //set title
            if (node.title === undefined && node.label !== undefined)
                node.title = "<b>" + node.label + "</b>" + "[" + node.id + "]";

            //set group
            if (node.group === undefined && node.categories instanceof Array)
                node.group = node.categories[0];
        });

        edges.forEach((edge: any) => {
            if (edge.id === undefined)
                edge.id = counterEdge++;
        });

        return {
            nodes: nodes,
            edges: edges
        };
    }

    private constructor(loadData?: (callback: () => void) => void) {
        if (loadData !== undefined)
            this._callbackLoadData = loadData;
    }

    private _processGson(gson: Gson, translate?: (source: Gson) => NodeNEdges) {
        this._labels = gson.categories;
        var local = this;
        if (translate === undefined) {
            translate = local._defaultTranslateGson2GraphData;
        }

        //translate gson to composite empty fields
        var data = translate(gson);
        this._nodes = data.nodes;
        this._edges = data.edges;
        this._createIndexDB();
    }

    private _createIndexDB() {
        //create indices
        var indexDB = this._indexDB;

        this._nodes.forEach((x: any) => {
            indexDB._mapId2Node.set(x.id, x);
        });

        this._edges.forEach((x: any) => {
            indexDB._mapId2Edge.set(x.id, x);

            //create adjacent matrix
            var pairs = [{ _1: x.from, _2: x.to }, { _1: x.to, _2: x.from }];
            pairs.forEach((pair: Pair<string, string>) => {
                if (!indexDB._mapNodeId2NeighbourNodeIds.has(pair._1))
                    indexDB._mapNodeId2NeighbourNodeIds.set(pair._1, new Set<string>());

                var neighbours = indexDB._mapNodeId2NeighbourNodeIds.get(pair._1);
                neighbours.add(pair._2);
            });

            //create node pair->edges
            pairs.forEach((pair: Pair<string, string>) => {
                var key = "" + pair._1 + "-" + pair._2;
                if (!indexDB._mapNodePair2EdgeIds.has(key))
                    indexDB._mapNodePair2EdgeIds.set(key, new Set<string>());

                var edges = indexDB._mapNodePair2EdgeIds.get(key);
                edges.add(x.id);
            });
        });

        console.debug(indexDB);
    }

    public static fromGson(gson: Gson, translate?: (source: Gson) => NodeNEdges) {
        var graph = new LocalGraph();
        graph._callbackLoadData = (callbackAfterLoad: () => void) => {
            graph._processGson(gson, translate);
            callbackAfterLoad();
        };

        return graph;
    }

    public static fromGsonString(gsonString: string, translate?: (source: Gson) => NodeNEdges) {
        var graph = new LocalGraph();
        graph._callbackLoadData = (callbackAfterLoad: () => void) => {
            graph._processGson(JSON.parse(gsonString), translate);
            callbackAfterLoad();
        };

        return graph;
    }

    public static fromGsonFile(gsonURL, translate?: (source: Gson) => NodeNEdges) {
        var graph = new LocalGraph();
        graph._callbackLoadData = (callbackAfterLoad: () => void) => {
            $.getJSON(gsonURL, function (data) {
                graph._processGson(data, translate);
                callbackAfterLoad();
            });
        };

        return graph;
    }

    getNodeCategories(): object {
        return this._labels;
    }

    _async(fn: (timerId: number) => void) {
        //for tests
        if (typeof window == 'undefined') {
            fn(0);
        }
        else {
            var timerId;
            timerId = window.setTimeout(() => {
                fn(timerId);
            }, 1);
        }
    }

    requestConnect(callback: () => void) {
        var local: LocalGraph = this;
        this._async(() => {
            local._callbackLoadData(callback);
        });
    }

    requestGetNodeDescriptions(nodeIds: string[], callback: (descriptions: string[]) => void) {
        var local: LocalGraph = this;
        this._async(() =>
            callback(nodeIds.map(nodeId => {
                let node: any = local._getNode(nodeId);
                if (node.description !== undefined) {
                    return node.description;
                }

                return null;
            })));
    }

    requestLoadGraph(callback: (nodes: vis.Node[], edges: vis.Edge[]) => void) {
        var local: LocalGraph = this;
        this._async(() =>
            callback(local._nodes, local._edges));
    }

    requestSearch(expr: any, limit: number, callback: (nodes: vis.Node[]) => void) {
        var local: LocalGraph = this;
        this._async(() => {
            var results =
                expr instanceof Array ?
                    local._searchByExprArray(expr, limit) :
                    local._searchBySingleExpr(expr, limit);

            callback(results);
        }
        );
    }

    private _searchBySingleExpr(expr: any, limit: number): vis.Node[] {
        if (typeof (expr) === 'string')
            return this._searchByKeyword(expr.toString(), limit);

        return this._searchByExample(expr, limit);
    }

    private _searchByKeyword(keyword: string, limit: number): vis.Node[] {
        var results = [];
        var node: any;
        for (node of this._nodes) {
            if (node.label.indexOf(keyword) > -1) {
                results.push(node);
                if (results.length > limit)
                    break;
            }
        }

        return results;
    }

    private _searchByExample(example: any, limit: number): vis.Node[] {
        var results = [];

        for (var node of this._nodes) {
            var matches = true;
            for (let key in example) {
                if (node[key] != example[key]) {
                    matches = false;
                    break;
                }
            }

            if (matches) {
                results.push(node);
                if (results.length > limit)
                    break;
            }
        }

        return results;
    }

    private _searchByExprArray(exprs: any[], limit: number): vis.Node[] {
        var results = [];
        exprs.forEach((expr) => {
            results = results.concat(this._searchBySingleExpr(expr, limit));
        });

        return results;
    }

    requestGetNeighbours(nodeId: string, callback: (neighbourNodes: vis.Node[], neighbourEdges: vis.Node[]) => void) {
        var local: LocalGraph = this;
        this._async(() => {
            var neighbourEdges: vis.Node[] = Utils.distinct(
                local._edges.filter((edge: any) => {
                    return edge.from == nodeId || edge.from == nodeId;
                })
            );

            var neighbourNodeIds = Utils.distinct(
                Utils.flatMap(neighbourEdges, (edge: any) => {
                    return [edge.from, edge.to];
                })
            );

            var neighbourNodes: vis.Node[] = neighbourNodeIds.map((nodeId: string) => {
                return local._getNode(nodeId);
            });

            callback(neighbourNodes, neighbourEdges);
        });
    }

    requestUpdateNodesOfCategory(className: string, nodeIds: any[], showOrNot: boolean,
        callback: (updates: object[]) => void) {
        var local: LocalGraph = this;
        this._async(() => {
            var updates = [];
            nodeIds.forEach((nodeId) => {
                var update: any = { id: nodeId };
                var node: any = local._getNode(nodeId);
                var nls: string[] = node.categories;
                if (nls.indexOf(className) > -1) {
                    update.hidden = !showOrNot;
                }

                updates.push(update);
            });

            callback(updates);
        });
    }

    private _getNode(nodeId: string) {
        return this._indexDB._mapId2Node.get(nodeId);
    }

    private _getEdge(edgeId: string) {
        return this._indexDB._mapId2Edge.get(edgeId);
    }

    private _getEdgesInPath(path: string[]): string[] {
        var edges = [];
        var lastNodeId = null;

        for (var node of path) {
            if (lastNodeId != null) {
                this._getEdgesBetween(lastNodeId, node).forEach((edge) => {
                    edges.push(edge);
                });
            }

            lastNodeId = node;
        }

        return edges;
    }

    private _getEdgesBetween(startNodeId, endNodeId): Set<string> {
        return this._indexDB._mapNodePair2EdgeIds.get("" + startNodeId + "-" + endNodeId);
    }

    requestFindRelations(startNodeId: string, endNodeId: string, maxDepth: number,
        callback: (queryResults: QueryResults) => void, algDfsOrBfs: boolean = true) {
        var graph: LocalGraph = this;
        this._async((timerId: number) => {
            var results: string[][] = [];
            var pointer = 0;

            if (algDfsOrBfs)
                graph._findRelationsDFS(startNodeId, endNodeId, maxDepth,
                    results, [], 0);
            else
                graph._findRelationsBFS(startNodeId, endNodeId, maxDepth, results);

            var paths: RelationPath[] = results.map((path: string[]) => {
                return {
                    nodes: path.map((id: string) => {
                        return graph._getNode(id);
                    }),
                    edges: graph._getEdgesInPath(path).map((id: string) => {
                        return graph._getEdge(id);
                    }),
                };
            });

            callback({
                hasMore: false,
                paths: paths,
                queryId: "" + timerId,
            });
        });
    }

    requestGetMoreRelations(queryId: string,
        callback: (queryResults: QueryResults) => void) {
    }

    requestStopFindRelations(queryId: string) {
        window.clearTimeout(parseInt(queryId));
    }

    private _findRelationsDFS(startNodeId: string, endNodeId: string, maxDepth: number,
        results: string[][], path: string[], depth: number) {

        if (depth > maxDepth)
            return;

        var newPath = path.concat([startNodeId]);
        if (startNodeId == endNodeId) {
            //BINGO!!!
            results.push(newPath);
            return;
        }

        var gson = this;
        //get all adjant nodes
        var neighbours = this._indexDB._mapNodeId2NeighbourNodeIds.get(startNodeId);
        neighbours.forEach((nodeId: string) => {
            //no loop
            if (path.indexOf(nodeId) < 0) {
                gson._findRelationsDFS(nodeId,
                    endNodeId, maxDepth,
                    results, newPath, depth + 1);
            }
        }
        );
    }

    private _findRelationsBFS(startNodeId: string, endNodeId: string, maxDepth: number, results: string[][]) {
        var queue = new Array<{ nodeId: string, depth: number, path: string[] }>();

        queue.push({ nodeId: startNodeId, depth: 0, path: [startNodeId] });

        while (queue.length > 0) {
            var one = queue.shift();

            if (one.depth > maxDepth)
                continue;

            if (one.nodeId == endNodeId) {
                //BINGO!!!
                results.push(one.path);
                continue;
            }

            var neighbours = this._indexDB._mapNodeId2NeighbourNodeIds.get(one.nodeId);
            for (var neighbour of neighbours) {
                if (one.path.indexOf(neighbour) >= 0)
                    continue;

                var newPath = one.path.concat([neighbour]);
                queue.push({
                    nodeId: neighbour,
                    depth: one.depth + 1,
                    path: newPath
                });
            }
        }
    }
}