/* @flow weak */

import Query from "./queries/Query";

import Metadata from "./metadata/Metadata";
import Table from "./metadata/Table";
import Field from "./metadata/Field";

import MultiQuery, {
    isMultiDatasetQuery,
    convertToMultiDatasetQuery
} from "./queries/MultiQuery";
import StructuredQuery, {
    isStructuredDatasetQuery
} from "metabase-lib/lib/queries/StructuredQuery";
import NativeQuery, {
    isNativeDatasetQuery
} from "metabase-lib/lib/queries/NativeQuery";

import { memoize } from "metabase-lib/lib/utils";
import Utils from "metabase/lib/utils";
import * as Card_DEPRECATED from "metabase/lib/card";
import Query_DEPRECATED from "metabase/lib/query";

import { getParametersWithExtras } from "metabase/meta/Card";

import {
    summarize,
    pivot,
    filter,
    breakout,
    toUnderlyingRecords,
    drillUnderlyingRecords
} from "metabase/qb/lib/actions";
import { getMode } from "metabase/qb/lib/modes";

import _ from "underscore";
import { chain, assoc } from "icepick";

import type {
    Parameter as ParameterObject,
    ParameterId,
    ParameterValues
} from "metabase/meta/types/Parameter";
import type {
    DatasetQuery,
    Card as CardObject,
    StructuredDatasetQuery as StructuredDatasetQueryObject
} from "metabase/meta/types/Card";

import type {
    ClickAction,
    ClickObject,
    QueryMode
} from "metabase/meta/types/Visualization";
import { MetabaseApi, CardApi } from "metabase/services";
import { DatetimeFieldDimension } from "metabase-lib/lib/Dimension";
import { TableId } from "metabase/meta/types/Table";
import { DatabaseId } from "metabase/meta/types/Database";
import AtomicQuery from "metabase-lib/lib/queries/AtomicQuery";

// TODO: move these
type DownloadFormat = "csv" | "json" | "xlsx";
type RevisionId = number;
type ParameterOptions = "FIXME";

/**
 * This is a wrapper around a question/card object, which may contain one or more Query objects
 */
export default class Question {
    /**
     * The Question wrapper requires a metadata object because the queries it contains (like {@link StructuredQuery))
     * need metadata for accessing databases, tables and metrics.
     */
    _metadata: Metadata;

    /**
     * The plain object presentation of this question, equal to the format that Metabase REST API understands.
     * It is called `card` for both historical reasons and to make a clear distinction to this class.
     */
    _card: CardObject;

    /**
     * Parameter values mean either the current values of dashboard filters or SQL editor template parameters.
     * TODO Atte Keinänen 6/6/17: Why are parameter values considered a part of a Question?
     */
    _parameterValues: ParameterValues;

    /**
     * Question constructor
     */
    constructor(
        metadata: Metadata,
        card: CardObject,
        parameterValues?: ParameterValues
    ) {
        this._metadata = metadata;
        this._card = card;
        this._parameterValues = parameterValues || {};
    }

    /**
     *
     */
    static newQuestion({
        databaseId, tableId, metadata, parameterValues, ...cardProps
    }: { databaseId?: DatabaseId, tableId?: TableId, metadata: Metadata, parameterValues?: ParameterValues }) {
        const card = {
            name: cardProps.name || null,
            display: cardProps.display || "table",
            visualization_settings: cardProps.visualization_settings || {},
            dataset_query: cardProps.dataset_query || StructuredQuery.newStucturedQuery({ question: this, databaseId, tableId })
        };

       return new Question(metadata, card, parameterValues);
    }

    /**
     * A question contains either a:
     * - StructuredQuery for queries written in MBQL
     * - NativeQuery for queries written in data source's native query language
     * - MultiQuery that is composed from one or more structured or native queries
     *
     * This is just a wrapper object, the data is stored in `this._card.dataset_query` in a format specific to the query type.
     */
    @memoize query(): Query {
        const datasetQuery = this._card.dataset_query;

        if (isMultiDatasetQuery(datasetQuery)) {
            return new MultiQuery(this, datasetQuery);
        } else if (isStructuredDatasetQuery(datasetQuery)) {
            return new StructuredQuery(this, datasetQuery);
        } else if (isNativeDatasetQuery(datasetQuery)) {
            return new NativeQuery(this, datasetQuery);
        }

        throw new Error("Unknown query type: " + datasetQuery.type);
    }

    metadata(): Metadata {
        return this._metadata;
    }

    setCard(card: CardObject): Question {
        return new Question(this._metadata, card, this._parameterValues);
    }

    newQuestion() {
        return this.setCard(
            chain(this.card())
                .dissoc("id")
                .dissoc("name")
                .dissoc("description")
                .value()
        );
    }

    /**
     * Returns a new Question object with an updated query.
     * The query is saved to the `dataset_query` field of the Card object.
     */
    setQuery(newQuery: Query): Question {
        if (this._card.dataset_query !== newQuery.datasetQuery()) {
            return this.setCard(
                assoc(this.card(), "dataset_query", newQuery.datasetQuery())
            );
        }
    }

    setDatasetQuery(newDatasetQuery: DatasetQuery): Question {
        return this.setCard(
            assoc(this.card(), "dataset_query", newDatasetQuery)
        );
    }

    card() {
        return this._card;
    }

    /**
     * The visualization type of the question
     */
    display(): string {
        return this._card && this._card.display;
    }

    setDisplay(display) {
        return this.setCard(assoc(this.card(), "display", display));
    }

    /**
     * Question is valid (as far as we know) and can be executed
     */
    canRun(): boolean {
        return this.query().canRun();
    }

    canWrite(): boolean {
        return this._card && this._card.can_write;
    }

    /**
     * Conversion from a single query -centric question to a multi-query question
     */
    isMultiQuery(): boolean {
        return this.query() instanceof MultiQuery;
    }
    canConvertToMultiQuery(): boolean {
        const query = this.query();
        return query instanceof StructuredQuery && !query.isBareRows() && query.breakouts().length === 1;
    }
    convertToMultiQuery(): Question {
        // TODO Atte Keinänen 6/6/17: I want to be 99% sure that this doesn't corrupt the question in any scenario
        const multiDatasetQuery = convertToMultiDatasetQuery(this, this._card.dataset_query);
        return this.setCard(
            assoc(this._card, "dataset_query", multiDatasetQuery)
        );
    }

    /**
     * A convenience shorthand for getting the MultiQuery object for a multi-query question
     */
    multiQuery(): MultiQuery {
        if (!this.isMultiQuery()) {
            throw new Error("Tried to use `multiQuery()` shorthand on a non-multi-query question");
        }

        // $FlowFixMe
        return this.query();
    }

    /**
     * Returns a list of atomic queries (NativeQuery or StructuredQuery) contained in this question
     */
    atomicQueries(): AtomicQuery[] {
        const query = this.query();
        if (query instanceof MultiQuery) return query.atomicQueries()
        if (query instanceof AtomicQuery) return [query]
        return [];
    }

    /**
     * Visualization drill-through and action widget actions
     *
     * Although most of these are essentially a way to modify the current query, having them as a part
     * of Question interface instead of Query interface makes it more convenient to also change the current visualization
     */
    summarize(aggregation) {
        const tableMetadata = this.tableMetadata();
        return this.setCard(summarize(this.card(), aggregation, tableMetadata));
    }
    breakout(b) {
        return this.setCard(breakout(this.card(), b));
    }
    pivot(breakout, dimensions = []) {
        const tableMetadata = this.tableMetadata();
        return this.setCard(
            // $FlowFixMe: tableMetadata could be null
            pivot(this.card(), breakout, tableMetadata, dimensions)
        );
    }
    filter(operator, column, value) {
        return this.setCard(filter(this.card(), operator, column, value));
    }
    drillUnderlyingRecords(dimensions) {
        return this.setCard(drillUnderlyingRecords(this.card(), dimensions));
    }
    toUnderlyingRecords(): ?Question {
        const newCard = toUnderlyingRecords(this.card());
        if (newCard) {
            return this.setCard(newCard);
        }
    }
    toUnderlyingData(): Question {
        return this.setDisplay("table");
    }
    drillPK(field: Field, value: Value): ?Question {
        const query = this.query();
        if (query instanceof StructuredQuery) {
            return query
                .reset()
                .setTable(field.table)
                .addFilter(["=", ["field-id", field.id], value])
                .question();
        }
    }

    // deprecated
    tableMetadata(): ?Table {
        const query = this.query();
        if (query instanceof StructuredQuery) {
            return query.table();
        } else {
            return null;
        }
    }

    mode(): ?QueryMode {
        return getMode(this.card(), this.tableMetadata());
    }

    actions(): ClickAction[] {
        const mode = this.mode();
        if (mode) {
            return _.flatten(
                mode.actions.map(actionCreator =>
                    actionCreator({ question: this }))
            );
        } else {
            return [];
        }
    }

    actionsForClick(clicked: ?ClickObject): ClickAction[] {
        const mode = this.mode();
        if (mode) {
            return _.flatten(
                mode.drills.map(actionCreator =>
                    actionCreator({ question: this, clicked }))
            );
        } else {
            return [];
        }
    }

    /**
     * A user-defined name for the question
     */
    displayName(): ?string {
        return this._card && this._card.name;
    }

    id(): number {
        return this._card && this._card.id;
    }

    isSaved(): boolean {
        return !!this.id();
    }

    publicUUID(): string {
        return this._card && this._card.public_uuid;
    }

    getUrl(): string {
        return "";
    }
    getLineage(): ?Question {
        return null;
    }

    getPublicUrl(): string {
        return "";
    }
    getDownloadURL(format: DownloadFormat): string {
        return "";
    }

    // These methods require integration with Redux actions or REST API
    update(): Promise<void> {
        return new Promise(() => {});
    }
    save(): Promise<void> {
        return new Promise(() => {});
    }
    revert(revisionId: RevisionId): Promise<void> {
        return new Promise(() => {});
    }
    enablePublicSharing(): Promise<void> {
        return new Promise(() => {});
    }
    disablePublicSharing(): Promise<void> {
        return new Promise(() => {});
    }
    publishAsEmbeddable(): Promise<void> {
        return new Promise(() => {});
    }
    getVersionHistory(): Promise<void> {
        return new Promise(() => {});
    }

    /**
     * Runs the query and returns an array containing results for each single query.
     *
     * If we have a saved and clean single-query question, we use `CardApi.query` instead of a ad-hoc dataset query.
     * This way we benefit from caching and query optimizations done by Metabase backend.
     */
    async getResults({ cancelDeferred, isDirty = false, ignoreCache = false } = {}): [any] {
        const canUseCardApiEndpoint = !isDirty && !this.isMultiQuery() && this.isSaved()

        if (canUseCardApiEndpoint) {
            const queryParams = {
                cardId: this.id(),
                parameters: this.parameters(),
                ignore_cache: ignoreCache
            };

            return [await CardApi.query(queryParams, { cancelled: cancelDeferred.promise })]
        } else {
            const getDatasetQueryResult = (datasetQuery) =>
                MetabaseApi.dataset(datasetQuery, cancelDeferred ? {cancelled: cancelDeferred.promise} : {});

            const datasetQueries = this.atomicQueries().map(query => query.datasetQuery())
            return Promise.all(datasetQueries.map(getDatasetQueryResult));
        }
    }

    parameters(): ParameterObject[] {
        return getParametersWithExtras(this.card(), this._parameterValues);
    }

    createParameter(parameter: ParameterOptions) {}
    updateParameter(id: ParameterId, parameter: ParameterOptions) {}
    deleteParameter(id: ParameterId) {}

    // predicate function that dermines if the question is "dirty" compared to the given question
    isDirtyComparedTo(originalQuestion: Question) {
        // TODO Atte Keinänen 6/8/17: Reconsider these rules because they don't completely match
        // the current implementation which uses original_card_id for indicating that question has a lineage

        // The rules:
        //   - if it's new, then it's dirty when
        //       1) there is a database/table chosen or
        //       2) when there is any content on the native query
        //       3) when the query is a MultiDatasetQuery
        //   - if it's saved, then it's dirty when
        //       1) the current card doesn't match the last saved version

        if (!this._card) {
            return false;
        } else if (!this._card.id) {
            if (
                this._card.dataset_query.query &&
                this._card.dataset_query.query.source_table
            ) {
                return true;
            } else if (
                this._card.dataset_query.type === "native" &&
                !_.isEmpty(this._card.dataset_query.native.query)
            ) {
                return true;
            } else if (
                this._card.dataset_query.type === "multi"
            ) {
                return true;
            } else {
                return false;
            }
        } else {
            const origCardSerialized = originalQuestion.serializeForUrl();
            const currentCardSerialized = this.serializeForUrl({
                includeOriginalCardId: false
            });
            return currentCardSerialized !== origCardSerialized;
        }
    }

    serializeForUrl({ includeOriginalCardId = true } = {}) {
        // TODO Atte Keinänen 5/31/17: Remove code mutation and unnecessary copying
        const dataset_query = Utils.copy(this._card.dataset_query);
        if (dataset_query.query) {
            dataset_query.query = Query_DEPRECATED.cleanQuery(
                dataset_query.query
            );
        }

        const cardCopy = {
            name: this._card.name,
            description: this._card.description,
            dataset_query: dataset_query,
            display: this._card.display,
            parameters: this._card.parameters,
            visualization_settings: this._card.visualization_settings,
            ...(includeOriginalCardId
                ? // $FlowFixMe
                  { original_card_id: this._card.original_card_id }
                : {})
        };

        return Card_DEPRECATED.utf8_to_b64url(JSON.stringify(cardCopy));
    }
}
