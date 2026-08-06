
import os
import subprocess
from glob import glob
import pandas as pd
from module import *
import parmap
from tqdm.notebook import tqdm


MMACTION_DIR = '../mmaction2/'
PYTHON_ENV = 'python'

CONFIG = {
    'tsn':os.path.join(MMACTION_DIR, 'configs/recognition/tsn/tsn_r50_clip_feature_extraction_1x1x3_rgb.py'),
    'slowfast':os.path.join(MMACTION_DIR,'configs/recognition/slowfast/slowfast_r50_8x8x1_256e_kinetics400_rgb.py')
}
CHECKPOINT = {
    'tsn':'https://download.openmmlab.com/mmaction/recognition/tsn/tsn_r50_320p_1x1x3_100e_kinetics400_rgb/tsn_r50_320p_1x1x3_100e_kinetics400_rgb_20200702-cc665e2a.pth',
    'slowfast':'https://download.openmmlab.com/mmaction/recognition/slowfast/slowfast_r50_8x8x1_256e_kinetics400_rgb/slowfast_r50_8x8x1_256e_kinetics400_rgb_20200716-73547d2b.pth',
}


def video_path_to_output_path_dir(video_path, output_path):
    output_dir = os.path.dirname(output_path)
    output_path, ext = os.path.splitext(output_path)
    
    if os.path.isdir(output_dir):
        pass
    else:
        os.makedirs(output_dir, exist_ok = True)
        print(f"Create DIrectory {output_dir}")
        
    return output_path, output_dir

def example(video_path, feature_path, feature_type='tsn'):
    
    output_path = None
    
    output_name, output_dir = video_path_to_output_path_dir(video_path, feature_path)
    #print(video_path)
    #print(output_name)
    
    temp_video_list_path, temp_video_list = video_segmentation(
        video_path = video_path,
        temp_dir = os.path.join(MMACTION_DIR, 'temp')
    )
    
    try:
        output_path = feature_extract(
            video_list_path = temp_video_list_path,
            output_name = output_name,
            feature_type = feature_type 
        )
    except (subprocess.CalledProcessError) as e:
        output_path = None
        print(e)
        print(output_name)

    _ = delete_temporary_file(temp_video_list_path)
    
    return output_path

def process_function(params):
    value = params
    "----------------------------------------------------------------------"
    
    video_path = value['video_path']
    feature_path = value['feature_path']
    #feature_path = example(video_path, feature_path, feature_type='slowfast')
    feature_path = example(video_path, feature_path, feature_type='tsn')
    value['feature_path'] = feature_path
    
    "----------------------------------------------------------------------"
    return value


def get_key(path):
    path = os.path.basename(path)
    key, _ = os.path.splitext(path)
    key = key.split('_')
    if key[-1] in ['slowfast', 'tsn']:
        key = key[:-1]
    key = "_".join(key)
    key = key.strip()
    return key


def get_videos(video_root):
    video_root = os.path.join(video_root, '**/*.mp4')
    df_videos = glob(video_root, recursive=True)
    df_videos = pd.DataFrame({'video_path':df_videos})
    df_videos['video_id'] = df_videos['video_path'].map(get_key)
    df_videos = df_videos.sort_values(by=['video_path']).reset_index(drop=True)
    df_videos = df_videos.drop_duplicates(subset=['video_id']).reset_index(drop=True)
    print(f"Detect video files : {df_videos.shape[0]}")
    return df_videos

def get_features(feature_root):
    feature_root = os.path.join(feature_root, '**/*_tsn.pkl')
    df_features = glob(feature_root, recursive=True)
    df_features = pd.DataFrame({'feature_path':df_features})
    df_features['video_id'] = df_features['feature_path'].map(get_key)
    df_features = df_features.sort_values(by=['feature_path']).reset_index(drop=True)
    df_features = df_features.drop_duplicates(subset=['video_id']).reset_index(drop=True)
    print(f"Detect feature files : {df_features.shape[0]}")
    return df_features


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--video_root_path')
    parser.add_argument('--feature_root_path')
    parser.add_argument('--gpu', default=0)
    parser.add_argument('--core', default=3)
    
    args = parser.parse_args()


    os.environ['CUDA_VISIBLE_DEVICES'] = str(args.gpu)
    
    
    df_videos = get_videos(args.video_root_path)
    df_features = get_features(args.feature_root_path)
    
    df_videos = pd.merge(df_videos, df_features, on=['video_id'], how='outer')
    df_videos = df_videos[df_videos['feature_path'].isnull()].reset_index(drop=True)
    print(f"Process the remaining unprocessed {df_videos.shape[0]} videos")
    
    for i in tqdm(range(len(df_videos))):
        df_videos.loc[i, 'feature_path'] = df_videos.loc[i, 'video_path'].replace(args.video_root_path, args.feature_root_path)
    
    process_params = [df_videos.loc[i].to_dict() for i in reversed(range(len(df_videos)))]
    result = parmap.map(process_function, process_params, pm_pbar=True, pm_processes=int(args.core))
    print(pd.DataFrame(result))


