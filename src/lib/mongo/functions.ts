// MongoDB autocomplete vocabulary (pure): collection methods (db.<coll>.<method>)
// and query/update/aggregation operators ($...). Fed into the Mongo completion
// source alongside collection/field suggestions.

export interface MongoFn {
  name: string
  /** shown right-aligned in the popup (call shape) */
  signature: string
  /** longer description (info panel) */
  detail: string
}

// Collection methods — what you call after `db.<collection>.`.
export const MONGO_METHODS: MongoFn[] = [
  { name: 'find', signature: 'find(filter, projection)', detail: 'Query documents' },
  { name: 'findOne', signature: 'findOne(filter, projection)', detail: 'First matching document' },
  { name: 'aggregate', signature: 'aggregate([pipeline])', detail: 'Run an aggregation pipeline' },
  { name: 'countDocuments', signature: 'countDocuments(filter)', detail: 'Count matching documents' },
  { name: 'estimatedDocumentCount', signature: 'estimatedDocumentCount()', detail: 'Fast approximate count' },
  { name: 'distinct', signature: 'distinct(field, filter)', detail: 'Distinct values of a field' },
  { name: 'insertOne', signature: 'insertOne(doc)', detail: 'Insert one document' },
  { name: 'insertMany', signature: 'insertMany([docs])', detail: 'Insert many documents' },
  { name: 'updateOne', signature: 'updateOne(filter, update)', detail: 'Update the first match' },
  { name: 'updateMany', signature: 'updateMany(filter, update)', detail: 'Update all matches' },
  { name: 'replaceOne', signature: 'replaceOne(filter, doc)', detail: 'Replace the first match' },
  { name: 'deleteOne', signature: 'deleteOne(filter)', detail: 'Delete the first match' },
  { name: 'deleteMany', signature: 'deleteMany(filter)', detail: 'Delete all matches' },
  { name: 'createIndex', signature: 'createIndex(keys, options)', detail: 'Create an index' },
  { name: 'dropIndex', signature: 'dropIndex(name)', detail: 'Drop an index' },
  { name: 'drop', signature: 'drop()', detail: 'Drop the collection' },
  { name: 'renameCollection', signature: 'renameCollection(name)', detail: 'Rename the collection' },
]

// Operators — used inside filters / updates / pipelines (typed after `$`).
export const MONGO_OPERATORS: MongoFn[] = [
  // comparison
  { name: '$eq', signature: '{ field: { $eq: v } }', detail: 'Equals' },
  { name: '$ne', signature: '{ field: { $ne: v } }', detail: 'Not equal' },
  { name: '$gt', signature: '{ field: { $gt: v } }', detail: 'Greater than' },
  { name: '$gte', signature: '{ field: { $gte: v } }', detail: 'Greater than or equal' },
  { name: '$lt', signature: '{ field: { $lt: v } }', detail: 'Less than' },
  { name: '$lte', signature: '{ field: { $lte: v } }', detail: 'Less than or equal' },
  { name: '$in', signature: '{ field: { $in: [..] } }', detail: 'In array' },
  { name: '$nin', signature: '{ field: { $nin: [..] } }', detail: 'Not in array' },
  // logical
  { name: '$and', signature: '{ $and: [..] }', detail: 'Logical AND' },
  { name: '$or', signature: '{ $or: [..] }', detail: 'Logical OR' },
  { name: '$nor', signature: '{ $nor: [..] }', detail: 'Logical NOR' },
  { name: '$not', signature: '{ field: { $not: {..} } }', detail: 'Logical NOT' },
  // element / evaluation
  { name: '$exists', signature: '{ field: { $exists: true } }', detail: 'Field exists' },
  { name: '$type', signature: '{ field: { $type: "string" } }', detail: 'BSON type check' },
  { name: '$regex', signature: '{ field: { $regex: /re/ } }', detail: 'Regular expression' },
  { name: '$expr', signature: '{ $expr: {..} }', detail: 'Use aggregation expressions' },
  { name: '$mod', signature: '{ field: { $mod: [d, r] } }', detail: 'Modulo' },
  // array
  { name: '$all', signature: '{ field: { $all: [..] } }', detail: 'Array contains all' },
  { name: '$elemMatch', signature: '{ field: { $elemMatch: {..} } }', detail: 'Array element match' },
  { name: '$size', signature: '{ field: { $size: n } }', detail: 'Array length' },
  // update
  { name: '$set', signature: '{ $set: {..} }', detail: 'Set field values' },
  { name: '$unset', signature: '{ $unset: { field: "" } }', detail: 'Remove fields' },
  { name: '$inc', signature: '{ $inc: { field: n } }', detail: 'Increment' },
  { name: '$mul', signature: '{ $mul: { field: n } }', detail: 'Multiply' },
  { name: '$rename', signature: '{ $rename: { a: "b" } }', detail: 'Rename a field' },
  { name: '$min', signature: '{ $min: {..} }', detail: 'Update if smaller / min accumulator' },
  { name: '$max', signature: '{ $max: {..} }', detail: 'Update if larger / max accumulator' },
  { name: '$currentDate', signature: '{ $currentDate: {..} }', detail: 'Set to current date' },
  { name: '$push', signature: '{ $push: { arr: v } }', detail: 'Append to array' },
  { name: '$pull', signature: '{ $pull: { arr: v } }', detail: 'Remove from array' },
  { name: '$addToSet', signature: '{ $addToSet: { arr: v } }', detail: 'Add unique to array' },
  { name: '$pop', signature: '{ $pop: { arr: 1 } }', detail: 'Remove first/last array element' },
  // aggregation stages / accumulators
  { name: '$match', signature: '{ $match: {..} }', detail: 'Pipeline: filter' },
  { name: '$group', signature: '{ $group: { _id, .. } }', detail: 'Pipeline: group' },
  { name: '$project', signature: '{ $project: {..} }', detail: 'Pipeline: shape output' },
  { name: '$sort', signature: '{ $sort: {..} }', detail: 'Pipeline: sort' },
  { name: '$limit', signature: '{ $limit: n }', detail: 'Pipeline: limit' },
  { name: '$skip', signature: '{ $skip: n }', detail: 'Pipeline: skip' },
  { name: '$unwind', signature: '{ $unwind: "$arr" }', detail: 'Pipeline: expand array' },
  { name: '$lookup', signature: '{ $lookup: {..} }', detail: 'Pipeline: join' },
  { name: '$count', signature: '{ $count: "n" }', detail: 'Pipeline: count' },
  { name: '$sum', signature: '{ $sum: expr }', detail: 'Accumulator: sum' },
  { name: '$avg', signature: '{ $avg: expr }', detail: 'Accumulator: average' },
]
