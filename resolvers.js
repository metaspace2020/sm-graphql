/**
 * Created by intsco on 1/11/17.
 */

const sprintf = require('sprintf-js');

const smEngineConfig = require('./sm_config.json'),
  {esSearchResults, esCountResults} = require('./es_connector'),
  {datasetFilters, dsField} = require('./ds_filters'),
  config = require('./config');


const dbConfig = () => {
  const {host, database, user, password} = smEngineConfig.db;
  return {
    host, database, user, password,
    max: 10, // client pool size
    idleTimeoutMillis: 30000
  };
};

var pg = require('knex')({
  client: 'pg',
  connection: dbConfig(),
  searchPath: 'knex,public'
});

const Resolvers = {
  Person: {
    name(obj) { return obj.First_Name; },
    surname(obj) { return obj.Surname; },
    email(obj) { return obj.Email; }
  },
  
  Query: {
    datasetByName(_, { name }) {
      return pg.select().from('dataset').where('name', '=', name)
        .then((data) => {
          return data.length > 0 ? data[0] : null;
        })
        .catch((err) => {
          console.log(err); return null;
        });
    },
  
    dataset(_, { id }) {
      return pg.select().from('dataset').where('id', '=', id)
        .then((data) => {
          return data.length > 0 ? data[0] : null;
        })
        .catch((err) => {
          console.log(err); return null;
        });
    },
  
    allDatasets(_, {orderBy, sortingOrder, offset, limit, filter}) {
      let q = pg.select().from('dataset');
    
      console.log(JSON.stringify(filter));
    
      if (filter.name)
        q = q.where("name", "=", filter.name);
    
      for (var key in datasetFilters) {
        const val = filter[key];
        if (val)
          q = datasetFilters[key].pgFilter(q, val);
      }
    
      const orderVar = orderBy == 'ORDER_BY_NAME' ? 'name' : 'id';
      const ord = sortingOrder == 'ASCENDING' ? 'asc' : 'desc';
    
      console.log(q.toString());
    
      return q.orderBy(orderVar, ord).offset(offset).limit(limit)
        .catch((err) => { console.log(err); return []; });
    },
    
    allAnnotations(_, args) {
      return esSearchResults(args);
    },
    
    countAnnotations(_, args) {
      return esCountResults(args);
    },
  
    annotation(_, { id }) {
      return es.get({index: esIndex, type: 'annotation', id})
        .then((resp) => {
          return resp;
        }).catch((err) => {
          return null;
        });
    }
  },
  
  Analyzer: {
    resolvingPower(msInfo, { mz }) {
      const rpMz = msInfo.rp.mz,
        rpRp = msInfo.rp.Resolving_Power;
      if (msInfo.type.toUpperCase() == 'ORBITRAP')
        return Math.sqrt(rpMz / mz) * rpRp;
      else if (msInfo.type.toUpperCase() == 'FTICR')
        return (rpMz / mz) * rpRp;
      else
        return rpRp;
    }
  },
  
  Dataset: {
    metadataJson(ds) {
      return JSON.stringify(ds.metadata);
    },
    
    institution(ds) { return dsField(ds, 'institution'); },
    organism(ds) { return dsField(ds, 'organism'); },
    polarity(ds) { return dsField(ds, 'polarity').toUpperCase(); },
    ionisationSource(ds) { return dsField(ds, 'ionisationSource'); },
    maldiMatrix(ds) { return dsField(ds, 'maldiMatrix'); },
    
    submitter(ds) {
      return ds.metadata.Submitted_By.Submitter;
    },
    
    principalInvestigator(ds) {
      return ds.metadata.Submitted_By.Principal_Investigator;
    },
    
    analyzer(ds) {
      const msInfo = ds.metadata.MS_Analysis;
      return {
        'type': msInfo.Analyzer,
        'rp': msInfo.Detector_Resolving_Power
      };
    },
    
    /* annotations(ds, args) {
     args.datasetId = ds.id;
     return esSearchResults(args);
     } */
  },
  
  Annotation: {
    id(hit) {
      return hit._id;
    },
    
    sumFormula(hit) {
      return hit._source.sf;
    },
  
    possibleCompounds(hit) {
      const ids = hit._source.comp_ids.split('|');
      const names = hit._source.comp_names.split('|');
      let compounds = [];
      for (var i = 0; i < names.length; i++) {
        let id = ids[i];
        let infoURL;
        if (hit._source.db_name == 'HMDB') {
          id = sprintf.sprintf("HMDB%05d", id);
          infoURL = `http://www.hmdb.ca/metabolites/${id}`;
        } else if (hit._source.db_name == 'ChEBI') {
          id = "CHEBI:" + id;
          infoURL = `http://www.ebi.ac.uk/chebi/searchId.do?chebiId=${id}`;
        } else if (hit._source.db_name == 'SwissLipids') {
          id = sprintf.sprintf("SLM:%09d", id);
          infoURL = `http://swisslipids.org/#/entity/${id}`;
        } else if (hit._source.db_name == 'LIPID_MAPS') {
          infoURL = `http://www.lipidmaps.org/data/LMSDRecord.php?LMID=${id}`;
        }
      
        compounds.push({
          name: names[i],
          imageURL: `http://${config.MOL_IMAGE_SERVER_IP}/mol-images/${hit._source.db_name}/${id}.svg`,
          information: [{database: hit._source.db_name, url: infoURL}]
        });
      }
      return compounds;
    },
  
    adduct: (hit) => hit._source.adduct,
  
    mz: (hit) => parseFloat(hit._source.mz),
  
    fdrLevel: (hit) => hit._source.fdr,
  
    msmScore: (hit) => hit._source.msm,
  
    rhoSpatial: (hit) => hit._source.image_corr,
  
    rhoSpectral: (hit) => hit._source.pattern_match,
  
    rhoChaos: (hit) => hit._source.chaos,
  
    dataset(hit) {
      return {
        id: hit._source.ds_id,
        name: hit._source.ds_name,
        metadata: hit._source.ds_meta
      }
    },
    
    ionImage(hit) {
      return {
        // mz,
        // url:`http://alpha.metasp.eu/mzimage2/${db_id}/${ds_id}/${job_id}/${sf_id}/${sf}/${adduct}/0`
        url: hit._source.ion_image_url
      };
    },
  
    // fetches data without exposing database IDs to the client
    peakChartData(hit) {
      const {ds_id, job_id, db_id, sf_id, adduct} = hit._source;
      const add = adduct == "" ? "None" : adduct;
      const url = `http://${OLD_WEBAPP_IP_PRIVATE}/spectrum_line_chart_data/${ds_id}/${job_id}/${db_id}/${sf_id}/${add}`;
      return fetch(url).then(res => res.json()).then(json => JSON.stringify(json));
    },
      
    isotopeImages(hit) {
      let image_objs = [];
      for (url of hit.image_urls) {
        image_objs.push({
          url: url,
          mz: 100500
        })
      }
      return image_objs;
    }
  }
};

module.exports = Resolvers;