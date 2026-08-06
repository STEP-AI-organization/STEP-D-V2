from glob import glob
import pandas as pd
import numpy as np
import os
from datetime import datetime
import json
from tqdm import tqdm
import argparse

def get_time(time_string):
    _time = time_string.strip()
    _time = datetime.strptime(_time, "%M:%S.%f")
    _time = _time.minute * 60. + _time.second * 1. + _time.microsecond * 1e-6
    return _time

def get_key(path):
    path = os.path.basename(path)
    key, _ = os.path.splitext(path)
    key = key.split('_')
    if key[-1] in ['slowfast', 'tsn']:
        key = key[:-1]
    key = "_".join(key)
    key = key.strip()
    return key

def main(args):
    
    json_root_path = args.json_root_path
    feature_root_path = args.feature_root_path
    all_data_path = args.all_data_path
    dataset_list_path = args.dataset_list_path

    df_all_data = []
    df_json_list = glob(os.path.join(json_root_path, '**/*.json'),recursive=True)
    df_json_list = pd.DataFrame({'json_path':df_json_list})
    for i in tqdm(range(len(df_json_list)), desc="Load labeling"):
        json_path = df_json_list.loc[i, 'json_path']
        with open(json_path) as f:
            data = json.load(f)
        df_all_data.append(data)
    df_all_data = pd.DataFrame(df_all_data)
    
    df_features = glob(os.path.join(feature_root_path, "**/*.pkl"), recursive=True)
    df_features = pd.DataFrame({"feature_path":df_features})
    df_features['video_id'] = df_features['feature_path'].map(get_key)
    df_features = df_features.drop_duplicates(subset=['video_id'], keep='last').reset_index(drop=True)
    video_id_to_feature_path = df_features.set_index('video_id').to_dict()['feature_path']
    
    df_all_data['error'] = None
    all_data = {}
    for i in tqdm(range(len(df_all_data)), desc="Prepare dataset"):
        try:
            data = df_all_data.loc[i].to_dict()
            data['duration'] = float(data['duration'])

            trigger_info = data['trigger_info']
            for j in range(len(trigger_info)):
                timestamps = trigger_info[j]['timestamps']
                try:
                    trigger_info[j]['start'] = get_time(timestamps[0])
                    try:
                        trigger_info[j]['end'] = get_time(timestamps[1])
                    except (IndexError) as e:
                        trigger_info[j]['end'] = get_time(timestamps[0])
                except (ValueError) as e:
                    continue

            local_df = pd.DataFrame(trigger_info)
            change_cuts = local_df.loc[local_df['trigger'] == "Change due to cut"]
            change_cuts = np.unique(change_cuts[['start', 'end']]).tolist()
            change_cuts_prev = change_cuts.copy()
            change_cuts = []
            for x in change_cuts_prev:
                if x > 0. and x < data['duration']:
                    change_cuts.append(x)

            change_acts = local_df.loc[local_df['trigger'] == "Change of action"]
            change_acts = np.unique(change_acts[['start', 'end']]).tolist()
            change_acts_prev = change_acts.copy()
            change_acts = []
            for x in change_acts_prev:
                if x > 0. and x < data['duration']:
                    change_acts.append(x)

            change_events = change_acts + change_cuts
            change_events = np.unique(change_events).tolist()
            change_events = sorted(change_events)

            if len(change_events) < 0 :
                raise Exception('event does not exist')

            key = get_key(data['video_name'])
            fps = float(data['frame_rate'])

            all_data[key]={
                'path_feature':video_id_to_feature_path[key],
                'fps':fps,
                'duration':float(data['duration']),
                'num_frames':int(data['total_frame']),
                'f1_consis':data['f1_consis'],
                'f1_consis_avg':data['f1_consis_avg'],
                'change_event':[change_acts],
                'change_shot':[change_cuts],
                'substages_myframeidx':[list(map(lambda x : x*fps, change_events))],
                'substages_timestamps':[change_events],
            }
        except Exception as e:
            df_all_data.loc[i, 'error'] = f'{e}'
            pass 

    if True:
        tt=df_all_data.loc[~df_all_data['error'].isnull()]
        tt[['video_name', 'error']].to_excel('error_check.xlsx')
        
        
        
    all_fold = {}
    for video_id in tqdm(all_data.keys(), desc='Match feature embedding'):
        try:
            all_fold[video_id]=video_id_to_feature_path[video_id]
        except:
            tqdm.write(f'"{video_id}" did not mapping.')
    all_list = list(all_fold.keys())
    print(f'Total mapping dataset count : {len(all_list)}')
    
    print(f'Dataset split train 8 : validation 1 : test 1')
    keys = np.array(list(all_fold.keys()))
    np.random.shuffle(keys)
    length = len(all_data)
    train_length = int(length * 0.8)
    val_length = int(length * 0.9)
    train_keys = keys[:train_length]
    val_keys = keys[train_length:val_length]
    test_keys = keys[val_length:] 
    fold_dataset_list = {
        'train': train_keys.tolist(),
        'validation': val_keys.tolist(),
        'test': test_keys.tolist()
    }
    train_len = len(fold_dataset_list['train'])
    val_len = len(fold_dataset_list['validation'])
    test_len = len(fold_dataset_list['test'])

    print(f'Dataset split train {train_len} : validation {val_len} : test {test_len}')
    
    save_all_data_path = all_data_path
    with open(save_all_data_path, "w") as f:
        json.dump(all_data, f, indent=4)
    print(f"save prepare dataset path: {save_all_data_path}")


    save_dataset_list_path = dataset_list_path
    with open(save_dataset_list_path, mode='w') as f:
        json.dump(fold_dataset_list, f)
    print(f"save dataset split list path: {save_dataset_list_path}")



if __name__ == '__main__':

    parser = argparse.ArgumentParser()
    parser.add_argument('--json_root_path')
    parser.add_argument('--feature_root_path')
    parser.add_argument('--all_data_path')
    parser.add_argument('--dataset_list_path')

    args = parser.parse_args()
    main(args)
